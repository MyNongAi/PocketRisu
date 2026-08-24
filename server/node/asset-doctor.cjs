'use strict'

// Read-only asset diagnosis. The runner only keeps paths/metadata in memory;
// payload bytes are read sequentially for a small verification sample and are
// released before the next item. Repair lives in external-assets.cjs and is an
// explicit, hash-preserving operation.

const crypto = require('crypto')
const { isExternalAssetUri, parseExternalAssetUri, sha256 } = require('./external-assets.cjs')

const DEFAULT_SAMPLE_LIMIT = 12
const DEFAULT_MAX_SAMPLE_BYTES = 16 * 1024 * 1024
const DEFAULT_CONCURRENCY = 4
const DEFAULT_ISSUE_RECORD_LIMIT = 5_000

function clampInteger(value, fallback, min, max) {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) return fallback
    return Math.max(min, Math.min(max, parsed))
}

function isImageReference(reference, mimeType = '') {
    if (/^image\//i.test(String(mimeType))) return true
    return /\.(?:png|jpe?g|gif|webp|avif|bmp)(?:$|[?#])/i.test(String(reference))
}

function issueId(code, reference) {
    return crypto.createHash('sha256').update(`${code}\0${reference}`).digest('hex').slice(0, 24)
}

function groupReferences(references) {
    const grouped = new Map()
    for (const reference of Array.isArray(references) ? references : []) {
        const value = reference?.value
        if (typeof value !== 'string' || value.length === 0) continue
        let item = grouped.get(value)
        if (!item) {
            item = {
                reference: value,
                kind: isExternalAssetUri(value)
                    ? 'external'
                    : value.startsWith('external://') ? 'invalid-external' : 'internal',
                occurrences: 0,
                owners: [],
            }
            grouped.set(value, item)
        }
        const occurrences = Number.isSafeInteger(reference.occurrences) && reference.occurrences > 0
            ? reference.occurrences
            : 1
        item.occurrences += occurrences
        if (Array.isArray(reference.owners)) {
            for (const owner of reference.owners) {
                if (item.owners.length >= 5) break
                item.owners.push({
                    ownerType: owner?.ownerType || 'embedded',
                    ownerId: owner?.ownerId || null,
                    field: owner?.field || null,
                    path: owner?.path || null,
                })
            }
        } else if (item.owners.length < 5) {
            item.owners.push({
                ownerType: reference.ownerType || 'embedded',
                ownerId: reference.ownerId || null,
                field: reference.field || null,
                path: reference.path || null,
            })
        }
    }
    return [...grouped.values()]
}

async function mapLimit(items, concurrency, operation) {
    const results = new Array(items.length)
    let cursor = 0
    async function worker() {
        while (true) {
            const index = cursor++
            if (index >= items.length) return
            results[index] = await operation(items[index], index)
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker))
    return results
}

async function statWithBoundedRetry(provider, hash) {
    const attempts = provider?.managesRetries ? 1 : 3
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try { return await provider.stat(hash) }
        catch (error) {
            lastError = error
            if (attempt >= attempts || error?.retryable !== true) throw error
            await new Promise((resolve) => setTimeout(resolve, Math.min(400, 50 * (2 ** (attempt - 1)))))
        }
    }
    throw lastError
}

function publicError(error) {
    return {
        code: typeof error?.code === 'string' ? error.code : null,
        message: error?.message || String(error),
    }
}

async function diagnoseAssetReferences(options = {}) {
    const grouped = groupReferences(options.references)
    const manifestEntries = options.manifestEntries || []
    const manifest = new Map(manifestEntries.map((entry) => [entry.uri, entry]))
    const manifestByInternalKey = new Map()
    for (const entry of manifestEntries) {
        for (const fallback of Array.isArray(entry?.fallbacks) ? entry.fallbacks : []) {
            if (typeof fallback?.internalKey !== 'string') continue
            if (!manifestByInternalKey.has(fallback.internalKey)) manifestByInternalKey.set(fallback.internalKey, [])
            manifestByInternalKey.get(fallback.internalKey).push(entry)
        }
    }
    const providers = options.providers instanceof Map
        ? options.providers
        : new Map((options.providers || []).map((provider) => [provider.id, provider]))
    const sampleLimit = clampInteger(options.sampleLimit, DEFAULT_SAMPLE_LIMIT, 0, 100)
    const maxSampleBytes = clampInteger(options.maxSampleBytes, DEFAULT_MAX_SAMPLE_BYTES, 1, 32 * 1024 * 1024)
    const concurrency = clampInteger(options.concurrency, DEFAULT_CONCURRENCY, 1, 8)
    const issueRecordLimit = clampInteger(options.issueRecordLimit, DEFAULT_ISSUE_RECORD_LIMIT, 200, 20_000)
    let sampleClaims = 0
    let sampleQueue = Promise.resolve()
    let completed = 0

    const summary = {
        references: grouped.reduce((sum, item) => sum + item.occurrences, 0),
        uniqueAssets: grouped.length,
        internalAssets: grouped.filter((item) => item.kind === 'internal').length,
        externalAssets: grouped.filter((item) => item.kind === 'external').length,
        invalidExternalAssets: grouped.filter((item) => item.kind === 'invalid-external').length,
        healthy: 0,
        problems: 0,
        missing: 0,
        cacheProblems: 0,
        providerProblems: 0,
        integrityProblems: 0,
        fallbackCandidates: 0,
        hashVerifiedSamples: 0,
        decodedSamples: 0,
        decodeFailures: 0,
        skippedLargeSamples: 0,
    }
    const issues = []
    let issuesOmitted = 0

    function addIssue(item, code, message, extra = {}) {
        const issue = {
            id: issueId(code, item.reference),
            code,
            message,
            reference: item.reference,
            kind: item.kind,
            occurrences: item.occurrences,
            owners: item.owners,
            repairable: false,
            ...extra,
        }
        if (issues.length < issueRecordLimit) issues.push(issue)
        else issuesOmitted++
        summary.problems++
        if (['internal-missing', 'manifest-missing'].includes(code)) summary.missing++
        if (code === 'cache-corrupt') summary.cacheProblems++
        if (['provider-missing', 'provider-unavailable', 'size-mismatch'].includes(code)) summary.providerProblems++
        if (code === 'hash-mismatch') summary.integrityProblems++
        if (issue.fallbackAvailable) summary.fallbackCandidates++
        return issue
    }

    async function inspectFallbacks(uri) {
        if (typeof options.service?.inspectFallbacks !== 'function') return []
        try { return await options.service.inspectFallbacks(uri) }
        catch { return [] }
    }

    async function claimSample(size) {
        if (sampleLimit === 0 || sampleClaims >= sampleLimit) return false
        if (!Number.isFinite(size) || size < 0 || size > maxSampleBytes) {
            if (Number.isFinite(size) && size > maxSampleBytes) summary.skippedLargeSamples++
            return false
        }
        sampleClaims++
        return true
    }

    // Availability checks stay concurrent, but payload reads and image decode
    // are deliberately serialized. Otherwise four 32 MB samples plus decoder
    // scratch space could be resident at once despite the advertised bound.
    async function runSample(operation) {
        const current = sampleQueue.then(operation, operation)
        sampleQueue = current.catch(() => {})
        return current
    }

    await mapLimit(grouped, concurrency, async (item) => {
        let itemHealthy = true
        try {
            if (item.kind === 'invalid-external') {
                itemHealthy = false
                addIssue(item, 'invalid-external-reference', 'The external:// reference is malformed and cannot identify a provider object.')
            } else if (item.kind === 'internal') {
                let stat = null
                try { stat = await options.statInternal?.(item.reference) }
                catch { stat = null }
                const size = typeof stat === 'number' ? stat : stat?.size
                if (!Number.isFinite(size)) {
                    itemHealthy = false
                    const matching = manifestByInternalKey.get(item.reference) || []
                    let fallbackAvailable = false
                    let fallbackSource = null
                    for (const entry of matching.slice(0, 4)) {
                        const candidates = await inspectFallbacks(entry.uri)
                        const available = candidates.find((candidate) => candidate.available)
                        if (available) {
                            fallbackAvailable = true
                            fallbackSource = available.source
                            break
                        }
                    }
                    addIssue(item, 'internal-missing', 'The internal asset row is missing.', {
                        fallbackAvailable,
                        fallbackSource,
                        repairable: false,
                        servingFallback: fallbackAvailable,
                    })
                } else {
                    const mappedHashes = [...new Set((manifestByInternalKey.get(item.reference) || [])
                        .map((entry) => entry.hash)
                        .filter((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)))]
                    const fileName = item.reference.slice('assets/'.length).split('/').pop() || ''
                    const fileStem = fileName.includes('.') ? fileName.slice(0, fileName.lastIndexOf('.')) : fileName
                    const fileNameHash = /^[a-f0-9]{64}$/.test(fileStem) ? fileStem : null
                    const expectedHash = mappedHashes.length === 1 ? mappedHashes[0] : fileNameHash
                    const image = isImageReference(item.reference)
                    if ((image || expectedHash) && await claimSample(size)) {
                        await runSample(async () => {
                            let data = null
                            try {
                                data = await options.readInternal(item.reference)
                                if (!data) throw new Error('Internal asset disappeared during diagnosis')
                            } catch (error) {
                                itemHealthy = false
                                addIssue(item, 'internal-read-failed', 'The sampled internal asset could not be read.', {
                                    actualSize: size,
                                    error: publicError(error),
                                })
                            }
                            if (data && expectedHash) {
                                const actualHash = sha256(data)
                                if (actualHash !== expectedHash) {
                                    itemHealthy = false
                                    addIssue(item, 'hash-mismatch', 'The internal bytes do not match their content hash.', {
                                        expectedHash,
                                        actualHash,
                                        actualSize: size,
                                        repairable: false,
                                    })
                                } else {
                                    summary.hashVerifiedSamples++
                                }
                            }
                            if (data && image && typeof options.decodeImage === 'function') {
                                try {
                                    await options.decodeImage(data, item.reference)
                                    summary.decodedSamples++
                                } catch (error) {
                                    itemHealthy = false
                                    summary.decodeFailures++
                                    addIssue(item, 'decode-failed', 'The internal image could not be decoded.', {
                                        actualSize: size,
                                        error: publicError(error),
                                    })
                                }
                            }
                        })
                    }
                }
            } else {
                const parsed = parseExternalAssetUri(item.reference)
                const record = manifest.get(parsed.uri)
                if (!record) {
                    itemHealthy = false
                    addIssue(item, 'manifest-missing', 'The external reference has no manifest mapping.')
                    return
                }

                const provider = providers.get(parsed.providerId)
                if (!provider || provider.capabilities?.unsupported) {
                    itemHealthy = false
                    const fallbacks = await inspectFallbacks(parsed.uri)
                    const fallback = fallbacks.find((candidate) => candidate.available)
                    addIssue(item, 'provider-missing', 'The referenced external provider is not configured or unavailable.', {
                        providerId: parsed.providerId,
                        expectedSize: record.size ?? null,
                        fallbackAvailable: !!fallback,
                        fallbackSource: fallback?.source ?? null,
                        repairable: false,
                    })
                    return
                }

                const cached = options.service?.cache?.peek?.(parsed.uri)
                    ?? options.service?.cache?.get?.(parsed.uri)
                if (cached && sha256(cached) !== parsed.hash) {
                    itemHealthy = false
                    addIssue(item, 'cache-corrupt', 'The bounded memory cache does not match the asset hash.', {
                        providerId: parsed.providerId,
                        repairable: true,
                        repairAction: 'invalidate-cache',
                    })
                }

                let providerStat
                try {
                    if (provider.capabilities?.stat !== true || typeof provider.stat !== 'function') {
                        throw Object.assign(new Error('Provider does not support stat/HEAD checks'), { code: 'STAT_UNSUPPORTED' })
                    }
                    providerStat = await statWithBoundedRetry(provider, parsed.hash)
                } catch (error) {
                    itemHealthy = false
                    const fallbacks = await inspectFallbacks(parsed.uri)
                    const fallback = fallbacks.find((candidate) => candidate.available)
                    addIssue(item, 'provider-unavailable', 'The external object could not be reached.', {
                        providerId: parsed.providerId,
                        expectedSize: record.size ?? null,
                        fallbackAvailable: !!fallback,
                        fallbackSource: fallback?.source ?? null,
                        repairable: !!fallback && provider.capabilities?.write === true,
                        repairAction: fallback && provider.capabilities?.write === true ? 'restore-exact-hash' : null,
                        error: publicError(error),
                    })
                    return
                }

                const actualSize = Number.isFinite(providerStat?.size) ? providerStat.size : null
                if (Number.isFinite(record.size) && actualSize !== null && actualSize !== record.size) {
                    itemHealthy = false
                    const fallbacks = await inspectFallbacks(parsed.uri)
                    const fallback = fallbacks.find((candidate) => candidate.available)
                    addIssue(item, 'size-mismatch', 'The external object size differs from its manifest.', {
                        providerId: parsed.providerId,
                        expectedSize: record.size,
                        actualSize,
                        fallbackAvailable: !!fallback,
                        fallbackSource: fallback?.source ?? null,
                        repairable: !!fallback && provider.capabilities?.write === true,
                        repairAction: fallback && provider.capabilities?.write === true ? 'restore-exact-hash' : null,
                    })
                    return
                }

                if (await claimSample(actualSize ?? record.size)) {
                    await runSample(async () => {
                        let result = null
                        try {
                            result = await options.service.readWithMeta(parsed.uri, {
                                bypassCache: true,
                                allowFallback: false,
                                populateCache: false,
                            })
                            summary.hashVerifiedSamples++
                        } catch (error) {
                            itemHealthy = false
                            const fallbacks = await inspectFallbacks(parsed.uri)
                            const fallback = fallbacks.find((candidate) => candidate.available)
                            const code = error?.code === 'HASH_MISMATCH' ? 'hash-mismatch' : 'provider-unavailable'
                            addIssue(item, code, code === 'hash-mismatch'
                                ? 'The downloaded external bytes do not match the URI hash.'
                                : 'The external object passed stat but failed a sampled download.', {
                                providerId: parsed.providerId,
                                expectedSize: record.size ?? null,
                                actualSize,
                                fallbackAvailable: !!fallback,
                                fallbackSource: fallback?.source ?? null,
                                repairable: !!fallback && provider.capabilities?.write === true,
                                repairAction: fallback && provider.capabilities?.write === true
                                    ? 'restore-exact-hash'
                                    : null,
                                error: publicError(error),
                            })
                        }
                        if (result && isImageReference(item.reference, record.mimeType) && typeof options.decodeImage === 'function') {
                            try {
                                await options.decodeImage(result.data, item.reference)
                                summary.decodedSamples++
                            } catch (error) {
                                itemHealthy = false
                                summary.decodeFailures++
                                addIssue(item, 'decode-failed', 'The sampled external image could not be decoded.', {
                                    providerId: parsed.providerId,
                                    expectedSize: record.size ?? null,
                                    actualSize,
                                    repairable: false,
                                    error: publicError(error),
                                })
                            }
                        }
                    })
                }
            }
        } finally {
            if (itemHealthy) summary.healthy++
            completed++
            options.onProgress?.({ phase: 'checking', current: completed, total: grouped.length })
        }
    })

    return {
        summary,
        issues,
        issuesOmitted,
        samplePolicy: {
            maxSamples: sampleLimit,
            maxBytesPerSample: maxSampleBytes,
            note: 'Availability and size are checked for every unique reference; hash/decode checks use a bounded sequential sample.',
        },
    }
}

module.exports = {
    DEFAULT_SAMPLE_LIMIT,
    DEFAULT_MAX_SAMPLE_BYTES,
    DEFAULT_ISSUE_RECORD_LIMIT,
    diagnoseAssetReferences,
    groupReferences,
    isImageReference,
    statWithBoundedRetry,
}
