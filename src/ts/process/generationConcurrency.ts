export type GenerationKind = 'live' | 'background'

export interface ActiveGenerationDescriptor {
    chatKey: string
    kind: GenerationKind
    providerKey?: string
}

export interface GenerationAdmissionCandidate extends ActiveGenerationDescriptor {}

export interface GenerationConcurrencyPolicy {
    /** Maximum number of distinct chats that may generate at once. */
    maxConcurrentChats: number
    /** Default cap for requests sharing one provider/API route. */
    defaultProviderLimit: number
    /** Optional provider-specific overrides. Keys are stable provider route ids. */
    providerLimits?: Readonly<Record<string, number>>
}

export type GenerationAdmissionDecision =
    | { allowed: true }
    | {
        allowed: false
        reason: 'same-chat' | 'global-limit' | 'provider-limit'
        limit: number
        providerKey?: string
    }

export const DEFAULT_GENERATION_CONCURRENCY_POLICY: GenerationConcurrencyPolicy = {
    maxConcurrentChats: 2,
    // Two chats may share the same provider. A provider that only tolerates a
    // single in-flight call can override this key without changing the state
    // registry or the send pipeline.
    defaultProviderLimit: 2,
}

function normalizedLimit(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.floor(value))
}

/**
 * Pure admission check for chat generation concurrency.
 *
 * The caller owns state mutation. Keeping policy evaluation separate makes it
 * usable by the UI for a side-effect-free preflight and by the registry for the
 * final atomic claim.
 */
export function evaluateGenerationAdmission(
    active: readonly ActiveGenerationDescriptor[],
    candidate: GenerationAdmissionCandidate,
    policy: GenerationConcurrencyPolicy = DEFAULT_GENERATION_CONCURRENCY_POLICY,
): GenerationAdmissionDecision {
    if (active.some((entry) => entry.chatKey === candidate.chatKey)) {
        return { allowed: false, reason: 'same-chat', limit: 1 }
    }

    const maxConcurrentChats = normalizedLimit(policy.maxConcurrentChats)
    if (active.length >= maxConcurrentChats) {
        return { allowed: false, reason: 'global-limit', limit: maxConcurrentChats }
    }

    if (candidate.providerKey) {
        const configured = policy.providerLimits?.[candidate.providerKey]
        const providerLimit = normalizedLimit(configured ?? policy.defaultProviderLimit)
        const providerCount = active.reduce((count, entry) => (
            entry.providerKey === candidate.providerKey ? count + 1 : count
        ), 0)
        if (providerCount >= providerLimit) {
            return {
                allowed: false,
                reason: 'provider-limit',
                limit: providerLimit,
                providerKey: candidate.providerKey,
            }
        }
    }

    return { allowed: true }
}
