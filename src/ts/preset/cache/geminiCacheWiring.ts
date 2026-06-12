// Impure orchestration between the googleGemini adapter and the pure context-
// cache core (geminiContextCache.ts): looks up state, runs the pre-request
// decision, swaps the request body, and after the response fires the
// create/extend/remove side effects without ever blocking or throwing into the
// request path. Any failure here degrades to an uncached request — caching can
// never take the chat down. Design: gemini-cache-keeper-internalization.md §4-4.

import type { AdapterCacheContext } from '../adapter/types'
import {
    applyGeminiCacheToBody,
    buildGeminiCacheCreateBody,
    buildGeminiCacheEntry,
    buildGeminiCacheKey,
    bumpGeminiCacheInvalidationCount,
    computeGeminiCredentialFp,
    computeGeminiPrefixHash,
    createGeminiCachedContentsClient,
    decideGeminiCacheAfterResponse,
    deriveCachedContentsUrl,
    disableGeminiCacheSession,
    evaluateGeminiCacheBeforeRequest,
    getGeminiCacheEntry,
    getGeminiCacheInvalidationCount,
    isGeminiCacheSessionDisabled,
    removeGeminiCacheEntry,
    resetGeminiCacheInvalidationCount,
    resolveGeminiCacheConfig,
    setGeminiCacheEntry,
    type GeminiCachedContentsClient,
    type GeminiCachePreDecision,
    type ResolvedGeminiCacheConfig,
} from './geminiContextCache'

export interface GeminiCacheTurn {
    // Request body to send (cache applied on a hit; the input body otherwise).
    // The input body is never mutated.
    body: Record<string, unknown>
    // Post-response hook: pass the response's usage promptTokens (undefined when
    // no usage was observed). Fire-and-forget — returns immediately and never
    // throws; cache create/extend/remove run in the background.
    finish(promptTokens: number | undefined): void
}

// Pre-request step. Returns null when caching does not participate in this
// request (off / no cache point / session disabled / unrecognized URL / empty
// suffix) — the caller then sends the original body and skips finish().
export function beginGeminiCacheTurn(args: {
    cache: AdapterCacheContext
    url: string                          // prepared chat URL (cachedContents URL is derived from it)
    headers: Record<string, string>      // prepared chat headers (same auth reused for cache calls)
    body: Record<string, unknown>        // prepared chat body (pre-cache)
    modelId: string
    credentialKey: string | undefined    // raw key, fingerprinted for rotation detection
    boundaryIndex: number | null         // last native cachePoint as a contents index
    fetchImpl?: typeof fetch
}): GeminiCacheTurn | null {
    try {
        return beginTurn(args)
    } catch (err) {
        console.warn('[gemini-cache] skipped for this request (pre-request step failed)', err)
        return null
    }
}

function beginTurn(args: Parameters<typeof beginGeminiCacheTurn>[0]): GeminiCacheTurn | null {
    const config = resolveGeminiCacheConfig(args.cache.promptCaching)
    if (!config) return null
    // No native cachePoint → caching does not participate at all (spec §4-4).
    if (args.boundaryIndex === null) return null
    // v1 never caches tool-enabled requests (request.ts already gates; this is
    // defense in depth against customBody-smuggled tools).
    if (args.body.tools !== undefined || args.body.toolConfig !== undefined) return null
    const key = buildGeminiCacheKey(args.cache.chatKey, args.cache.task, args.cache.presetId)
    if (isGeminiCacheSessionDisabled(key)) return null
    const cachedContentsUrl = deriveCachedContentsUrl(args.url)
    if (!cachedContentsUrl) return null

    const client = createGeminiCachedContentsClient({
        cachedContentsUrl,
        headers: args.headers,
        fetchImpl: args.fetchImpl,
    })
    const now = Date.now()
    const credentialFp = computeGeminiCredentialFp(args.credentialKey ?? '')
    const contents = Array.isArray(args.body.contents) ? (args.body.contents as unknown[]) : []
    const systemInstruction = args.body.systemInstruction

    const pre = evaluateGeminiCacheBeforeRequest({
        entry: getGeminiCacheEntry(key, now),
        now,
        modelId: args.modelId,
        credentialFp,
        boundaryIndex: args.boundaryIndex,
        systemInstruction,
        contents,
    })

    let body = args.body
    if (pre.action === 'invalidate') {
        // Stored cache no longer matches: drop state, delete the remote cache in
        // the background, send uncached. Only prefix-mismatch counts toward the
        // consecutive-invalidation auto-off guard.
        if (pre.countsTowardGuard) bumpGeminiCacheInvalidationCount(key)
        removeGeminiCacheEntry(key)
        void client.remove(pre.staleCacheName)
    } else if (pre.action === 'apply') {
        // Empty-suffix guard: generateContent requires non-empty contents, so a
        // cache covering the entire prompt (e.g. a reroll whose cachePoint sits
        // on the last message) cannot be applied. Send uncached and keep the
        // entry — the next turn's longer prompt applies it normally.
        if (pre.boundaryIndex >= contents.length) return null
        body = applyGeminiCacheToBody(args.body, pre)
    }

    return {
        body,
        finish: (promptTokens) => {
            void runPostResponse({
                key,
                pre,
                client,
                config,
                modelId: args.modelId,
                credentialFp,
                systemInstruction,
                contents,
                boundaryIndex: args.boundaryIndex,
                promptTokens,
            }).catch((err) => console.warn('[gemini-cache] post-response step failed', err))
        },
    }
}

// Post-response side effects, driven by the pure after-response decision.
// Runs detached from the chat request; every cache API call resolves to a
// result object (the client never throws).
async function runPostResponse(args: {
    key: string
    pre: GeminiCachePreDecision
    client: GeminiCachedContentsClient
    config: ResolvedGeminiCacheConfig
    modelId: string
    credentialFp: string
    systemInstruction: unknown
    contents: readonly unknown[]
    boundaryIndex: number | null
    promptTokens: number | undefined
}): Promise<void> {
    const now = Date.now()
    const entry = getGeminiCacheEntry(args.key, now)
    const post = decideGeminiCacheAfterResponse({
        pre: args.pre,
        entry,
        now,
        promptTokens: args.promptTokens,
        boundaryIndex: args.boundaryIndex,
        consecutiveInvalidations: getGeminiCacheInvalidationCount(args.key),
        config: args.config,
    })
    if (post.resetInvalidations) resetGeminiCacheInvalidationCount(args.key)
    if (post.disableSession) disableGeminiCacheSession(args.key)
    if (post.extendTtl && entry) {
        const result = await args.client.extend(entry.cacheName, args.config.ttlSec)
        // Mirror the server's new expiry locally so the next pre-request check
        // sees the extended lifetime. Failures are ignored (next turn misses).
        if (result.ok) {
            setGeminiCacheEntry(args.key, { ...entry, expiresAt: now + args.config.ttlSec * 1000 })
        }
    }
    if (post.create) {
        const boundaryIndex = post.create.boundaryIndex
        const result = await args.client.create(buildGeminiCacheCreateBody({
            modelId: args.modelId,
            ttlSec: args.config.ttlSec,
            systemInstruction: args.systemInstruction,
            contents: args.contents,
            boundaryIndex,
        }))
        if (!result.ok || !result.name) {
            // e.g. 400 below the model's minimum cacheable tokens — log and try
            // again on a later turn.
            console.warn('[gemini-cache] cache creation failed', result.status)
            return
        }
        setGeminiCacheEntry(args.key, buildGeminiCacheEntry({
            cacheName: result.name,
            modelId: args.modelId,
            now,
            ttlSec: args.config.ttlSec,
            expireTimeMs: result.expireTimeMs,
            boundaryIndex,
            prefixHash: computeGeminiPrefixHash(args.systemInstruction, args.contents, boundaryIndex),
            promptTokensAtCreation: args.promptTokens ?? 0,
            credentialFp: args.credentialFp,
            consecutiveInvalidations: getGeminiCacheInvalidationCount(args.key),
        }))
        // One-active-cache invariant: the replaced cache is deleted only after
        // the new one is registered.
        if (post.create.replaceCacheName) void args.client.remove(post.create.replaceCacheName)
    }
}
