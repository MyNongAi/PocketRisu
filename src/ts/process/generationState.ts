import { derived, get, writable, type Readable } from "svelte/store"
import {
    DEFAULT_GENERATION_CONCURRENCY_POLICY,
    evaluateGenerationAdmission,
    type GenerationAdmissionDecision,
    type GenerationConcurrencyPolicy,
    type GenerationKind,
} from './generationConcurrency'

// Per-chat generation state, keyed by the REAL chat id (chat.id) — not the
// per-request generationId that flows through request args as `chatId` (see
// .agent/notes/generation-state-keying.md §1-bis). Keyed-Map pattern modeled
// on status/requestStatus.ts.
//
// Compatibility layer: the historical global stores `doingChat` /
// `chatProcessStage` live here (re-exported from process/index.svelte for
// existing consumers) and are fed from the map, so with a single active
// generation behavior is unchanged. All lifecycle writes go through the
// helpers below so the stores and the map never diverge.
//
// Non-persistent, memory only: never touches db/localStorage/.bin.

export interface GenState {
    generationId: string
    // 'live' = a send running in this client (feeds the global doingChat
    // compat store). 'background' = a server-side job reattached by
    // jobRecovery: it holds the per-chat send guard but must NOT flip the
    // global doingChat (that would lock legacy global-only consumers for up to
    // the job-poll deadline).
    kind: GenerationKind
    /** Pipeline stage for this chat; UI must not display another chat's stage. */
    stage: number
    abortController?: AbortController
    /** Immutable routing/target identity captured before the first await. */
    context?: GenerationContextIdentity
}

export interface GenerationContextIdentity {
    characterId?: string
    chatId?: string
    presetId?: string
    providerKey?: string
    modelId?: string
}

export const generationStates = writable<Map<string, GenState>>(new Map())

// Compat stores. Kept writable: Suggestion.svelte pulses doingChat true→false
// to retrigger its subscriber (only while nothing is generating, so the pulse
// cannot diverge from the map).
export const doingChat = writable(false)
export const chatProcessStage = writable(0)

export const isAnyGenerating: Readable<boolean> = derived(generationStates, (m) => m.size > 0)

// Abort controllers registered by the UI before sendChat creates the map entry
// (the screen creates the controller, then sendChat registers the generation).
// Entries are copied — not moved — into the generation and survive the
// end/restart churn of auto-continue/resend (those endGeneration calls pass
// keepPendingAbort) so the Stop button can still reach the controller
// mid-send. A terminal endGeneration deletes the entry so a later unrelated
// generation cannot adopt a stale controller. Overwritten by the next
// registerAbort for the chat.
const pendingAborts = new Map<string, AbortController>()

// Legacy chats can lack chat.id; those share one fallback key so the guard and
// cleanup still pair up (same single-generation behavior as before).
export function chatGenKey(chatId: string | undefined): string {
    return chatId ?? 'nochat'
}

// Global compat store = "any LIVE generation running". Background entries hold
// only the per-chat guard. Exported so the Suggestion.svelte pulse can
// re-converge the store with the map after its true→false toggle.
export function syncDoingChat(): void {
    let anyLive = false
    for (const entry of get(generationStates).values()) {
        if (entry.kind === 'live') {
            anyLive = true
            break
        }
    }
    doingChat.set(anyLive)
}

// Counts BOTH kinds: a chat with a background job must still block a new send.
export function isChatGenerating(chatKey: string): boolean {
    return get(generationStates).has(chatKey)
}

function activeDescriptors(states: ReadonlyMap<string, GenState>) {
    return [...states].map(([chatKey, state]) => ({
        chatKey,
        kind: state.kind,
        providerKey: state.context?.providerKey,
    }))
}

/** Side-effect-free preflight. `tryStartGeneration` repeats this atomically. */
export function getGenerationAdmission(
    chatKey: string,
    context?: GenerationContextIdentity,
    kind: GenerationKind = 'live',
    policy: GenerationConcurrencyPolicy = DEFAULT_GENERATION_CONCURRENCY_POLICY,
): GenerationAdmissionDecision {
    return evaluateGenerationAdmission(activeDescriptors(get(generationStates)), {
        chatKey,
        kind,
        providerKey: context?.providerKey,
    }, policy)
}

/**
 * Atomically claims a generation slot. This is the user-send entry point;
 * `startGeneration` remains the unconditional administrative path used when a
 * pre-existing server job is reattached during recovery.
 */
export function tryStartGeneration(
    chatKey: string,
    generationId: string,
    context?: GenerationContextIdentity,
    policy: GenerationConcurrencyPolicy = DEFAULT_GENERATION_CONCURRENCY_POLICY,
): GenerationAdmissionDecision {
    let decision: GenerationAdmissionDecision = { allowed: false, reason: 'global-limit', limit: 0 }
    generationStates.update((states) => {
        decision = evaluateGenerationAdmission(activeDescriptors(states), {
            chatKey,
            kind: 'live',
            providerKey: context?.providerKey,
        }, policy)
        if (!decision.allowed) {
            // A newly registered UI controller must not become a stale abort
            // target when a different chat already occupies the global/API cap.
            if (!states.has(chatKey)) pendingAborts.delete(chatKey)
            return states
        }
        const next = new Map(states)
        next.set(chatKey, {
            generationId,
            kind: 'live',
            stage: 0,
            abortController: pendingAborts.get(chatKey),
            context,
        })
        return next
    })
    if (decision.allowed) syncDoingChat()
    return decision
}

export function startGeneration(chatKey: string, generationId: string, kind: GenerationKind = 'live'): void {
    const abortController = pendingAborts.get(chatKey)
    generationStates.update((m) => {
        const next = new Map(m)
        next.set(chatKey, { generationId, kind, stage: 0, abortController })
        return next
    })
    syncDoingChat()
}

// Keep the legacy global stage for old consumers, while the chat screen reads
// its own keyed stage so concurrent chat B cannot repaint chat A's loader.
export function setGenerationStage(chatKey: string, stage: number): void {
    generationStates.update((states) => {
        const current = states.get(chatKey)
        if (!current) return states
        const next = new Map(states)
        next.set(chatKey, { ...current, stage })
        return next
    })
    chatProcessStage.set(stage)
}

// keepPendingAbort: the auto-continue/resend restart paths end and immediately
// restart the generation under the same key mid-send; they keep the pending
// controller so the restarted entry re-adopts it. Terminal ends (the default)
// drop it so it cannot be adopted by a later unrelated generation.
export function endGeneration(chatKey: string, opts?: { keepPendingAbort?: boolean }): void {
    if (!opts?.keepPendingAbort) {
        pendingAborts.delete(chatKey)
    }
    generationStates.update((m) => {
        if (!m.has(chatKey)) return m
        const next = new Map(m)
        next.delete(chatKey)
        return next
    })
    syncDoingChat()
}

// Blanket reset — replaces the old external `doingChat.set(false)` cleanup
// writes (multisend / hotkey preview / DevTool / plugin apiV3) so the map and
// the compat store clear together. Does not abort: neither did the old writes.
// Background entries (reattached server-side jobs) survive: these cleanup
// writes concern the live send pipeline and must not orphan a running job's
// guard (its poll loop still needs to release it).
export function endAllGenerations(): void {
    generationStates.update((m) => {
        const next = new Map<string, GenState>()
        for (const [key, entry] of m) {
            if (entry.kind === 'background') next.set(key, entry)
        }
        return next
    })
    const survivors = get(generationStates)
    for (const key of [...pendingAborts.keys()]) {
        if (!survivors.has(key)) pendingAborts.delete(key)
    }
    syncDoingChat()
}

// Called by the UI right before sendChat, while the map entry does not exist
// yet; startGeneration adopts the pending controller into the entry.
export function registerAbort(chatKey: string, controller: AbortController): void {
    const entry = get(generationStates).get(chatKey)
    if (entry) {
        generationStates.update((m) => {
            const cur = m.get(chatKey)
            if (!cur) return m
            const next = new Map(m)
            next.set(chatKey, { ...cur, abortController: controller })
            return next
        })
    } else {
        pendingAborts.set(chatKey, controller)
    }
}

// Abort THIS chat's generation (registered or still pending). Returns whether
// a not-yet-aborted controller was actually aborted — false when nothing was
// wired (or everything reachable had already been aborted).
export function abortGeneration(chatKey: string): boolean {
    const entry = get(generationStates).get(chatKey)
    const pending = pendingAborts.get(chatKey)
    let aborted = false
    for (const controller of new Set([entry?.abortController, pending])) {
        if (controller && !controller.signal.aborted) {
            controller.abort()
            aborted = true
        }
    }
    return aborted
}
