import { describe, expect, test, vi } from 'vitest'
import {
    RATE_LIMIT_WAITS_MS,
    isRateLimitFailure,
    newRateLimitState,
    nextRateLimitWait,
    rateLimitBudgetMs,
    waitUnlessAborted,
} from './rateLimitRetry'

describe('rateLimitBudgetMs', () => {
    test('5 minutes when the setting is missing, 0 turns it off, 30 at most', () => {
        expect(rateLimitBudgetMs(undefined)).toBe(5 * 60_000)
        expect(rateLimitBudgetMs(0)).toBe(0)
        expect(rateLimitBudgetMs(12)).toBe(12 * 60_000)
        expect(rateLimitBudgetMs(500)).toBe(30 * 60_000)
        expect(rateLimitBudgetMs(-3)).toBe(0)
        expect(rateLimitBudgetMs(Number.NaN)).toBe(5 * 60_000)
    })
})

describe('nextRateLimitWait', () => {
    test('waits longer each time, then keeps the longest wait', () => {
        const state = newRateLimitState()
        let now = 1_000_000
        const waits: number[] = []
        for (let i = 0; i < 9; i++) {
            const wait = nextRateLimitWait(state, now, 60 * 60_000)!
            waits.push(wait)
            now += wait + 1500 // the 429 itself takes a moment
        }
        expect(waits).toEqual([...RATE_LIMIT_WAITS_MS, 30000, 30000, 30000])
        expect(state.waits).toBe(9)
    })

    test('stops once the next wait would end past the budget, counted from the first 429', () => {
        const state = newRateLimitState()
        const start = 5_000
        expect(nextRateLimitWait(state, start, 10_000)).toBe(1000)
        expect(nextRateLimitWait(state, start + 2_000, 10_000)).toBe(2000)
        expect(nextRateLimitWait(state, start + 5_000, 10_000)).toBe(4000)
        // 5 s + 8 s > 10 s
        expect(nextRateLimitWait(state, start + 9_500, 10_000)).toBeNull()
        expect(state.waits).toBe(3)
    })

    test('a budget of 0 never waits', () => {
        expect(nextRateLimitWait(newRateLimitState(), 0, 0)).toBeNull()
    })
})

describe('waitUnlessAborted', () => {
    test('resolves true after the wait', async () => {
        vi.useFakeTimers()
        try {
            const done = waitUnlessAborted(1000)
            await vi.advanceTimersByTimeAsync(1000)
            await expect(done).resolves.toBe(true)
        } finally {
            vi.useRealTimers()
        }
    })

    test('resolves false at once when stopped', async () => {
        vi.useFakeTimers()
        try {
            const controller = new AbortController()
            const done = waitUnlessAborted(30_000, controller.signal)
            controller.abort()
            await expect(done).resolves.toBe(false)
            await expect(waitUnlessAborted(1000, controller.signal)).resolves.toBe(false)
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('isRateLimitFailure', () => {
    test('a preset rate-limit error and Google RESOURCE_EXHAUSTED; nothing else', () => {
        expect(isRateLimitFailure({ type: 'fail', rateLimited: true, result: 'HTTP 429' })).toBe(true)
        expect(isRateLimitFailure({ type: 'fail', result: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}' })).toBe(true)
        expect(isRateLimitFailure({ type: 'fail', result: 'Gemini API error 503: overloaded' })).toBe(false)
        expect(isRateLimitFailure({ type: 'success', result: 'RESOURCE_EXHAUSTED' })).toBe(false)
    })
})
