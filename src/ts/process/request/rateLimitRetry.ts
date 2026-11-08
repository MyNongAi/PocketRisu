// A 429 (a rate limit; Google says RESOURCE_EXHAUSTED) is refused at the
// door: it is not billed and says nothing about the request, only that the
// provider has no room right now. The retry count (db.requestRetrys) is for
// failures that can cost money and usually repeat the same way (a block, an
// empty answer, a 400), so a 429 does not spend it. It waits longer each time
// and keeps trying for a few minutes instead (the user's request, 2026-11-09:
// "전송버튼 다시 누르기 귀찮음"; six 429s in the request log, each sent once).

/** The waits between tries after a 429, in ms. The last one repeats. */
export const RATE_LIMIT_WAITS_MS = [1000, 2000, 4000, 8000, 15000, 30000] as const

export const RATE_LIMIT_DEFAULT_MINUTES = 5
export const RATE_LIMIT_MAX_MINUTES = 30

/** How long to keep trying after the first 429 (db.nodeOnlyRateLimitWaitMinutes); 0 turns it off. */
export function rateLimitBudgetMs(minutes: unknown): number {
    const value = typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : RATE_LIMIT_DEFAULT_MINUTES
    return Math.min(Math.max(0, Math.floor(value)), RATE_LIMIT_MAX_MINUTES) * 60_000
}

export type RateLimitState = {
    /** When the first 429 of this run came. */
    firstAt: number | null
    /** How many waits have run. */
    waits: number
}

export function newRateLimitState(): RateLimitState {
    return { firstAt: null, waits: 0 }
}

/**
 * The wait before the next try after a 429, or null when it would end past
 * the budget (counted from the first 429). Counts the wait in `state`.
 */
export function nextRateLimitWait(state: RateLimitState, now: number, budgetMs: number): number | null {
    if (budgetMs <= 0) return null
    const firstAt = state.firstAt ?? now
    const wait = RATE_LIMIT_WAITS_MS[Math.min(state.waits, RATE_LIMIT_WAITS_MS.length - 1)]
    if (now + wait - firstAt > budgetMs) return null
    state.firstAt = firstAt
    state.waits += 1
    return wait
}

/** Waits `ms`, or less when `signal` aborts first. Resolves false when aborted. */
export function waitUnlessAborted(ms: number, signal?: AbortSignal | null): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
        const onAbort = () => {
            clearTimeout(timer)
            resolve(false)
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve(true)
        }, ms)
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

/**
 * Whether a failed request was a 429: a model preset's rate-limit error, or
 * Google's RESOURCE_EXHAUSTED on the classic path (request/google.ts).
 */
export function isRateLimitFailure(response: { type: string, rateLimited?: boolean, result?: unknown }): boolean {
    if (response.type !== 'fail') return false
    if (response.rateLimited) return true
    return typeof response.result === 'string' && response.result.includes('RESOURCE_EXHAUSTED')
}
