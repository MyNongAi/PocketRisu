import { describe, expect, it } from 'vitest'
import { bucketCost, costSummary, defaultCostSettings, newWarnings, shouldHardStop, type CostBucket } from './apiCost'

const row = (patch: Partial<CostBucket> = {}): CostBucket => ({
    day: '2026-11-02', model: 'model-a', requests: 1, failed: 0,
    inputTokens: 1_000_000, outputTokens: 500_000, cachedTokens: 0,
    reasoningTokens: 0, missingTokenRequests: 0, avgDurationMs: null, ...patch,
})

describe('API cost', () => {
    it('uses rates by model and separates missing rates and missing tokens', () => {
        const rates = { 'model-a': { input: 2, output: 4 } }
        expect(bucketCost(row(), rates).amount).toBe(4)
        expect(bucketCost(row({ model: 'model-b' }), rates).unpriced).toBe(true)
        expect(bucketCost(row({ inputTokens: 0, outputTokens: 0, missingTokenRequests: 1 }), rates))
            .toEqual({ amount: null, missingTokens: 1, unpriced: false })
    })

    it('uses output rate for reasoning unless explicitly priced', () => {
        const r = row({ inputTokens: 0, outputTokens: 500_000, reasoningTokens: 200_000 })
        expect(bucketCost(r, { 'model-a': { output: 4 } }).amount).toBe(2)
        expect(bucketCost(r, { 'model-a': { output: 4, reasoning: 8 } }).amount).toBe(2.8)
    })

    it('prices cached input separately and applies optional long prompt rates', () => {
        const r = row({ inputTokens: 300_000, cachedTokens: 100_000, outputTokens: 100_000 })
        const rates = { 'model-a': { input: 2, output: 4, cachedInput: 1, longInput: 3, longOutput: 6 } }
        expect(bucketCost(r, rates).amount).toBeCloseTo(0.9)
        expect(bucketCost({ ...r, longPrompt: true }, rates).amount).toBeCloseTo(1.3)
    })

    it('does not take a day of short prompts for a long one', () => {
        // Five 100k prompts in a day are five short requests, not one long one.
        const day = row({ requests: 5, inputTokens: 500_000, outputTokens: 0 })
        expect(bucketCost(day, { 'model-a': { input: 2, longInput: 4 } }).amount).toBe(1)
    })

    it('computes budget and latest actual adjustment before later estimates', () => {
        const settings = { ...defaultCostSettings(), rates: { 'model-a': { input: 2, output: 4 } },
            budgetUsd: 20, startDay: '2026-11-01',
            adjustments: [{ day: '2026-11-02', amountUsd: 10 }] }
        const summary = costSummary([row(), row({ day: '2026-11-03' })], settings, '2026-11-04')
        expect(summary.spent).toBe(14)
        expect(summary.remaining).toBe(6)
        expect(summary.percent).toBe(70)
        expect(summary.dailyAverage).toBe(3.5)
        expect(summary.depletionDay).toBe('2026-11-06')
        expect(newWarnings(summary.percent, settings)).toEqual([50])
        expect(shouldHardStop(summary.percent, settings)).toBe(false)
        expect(shouldHardStop(100, settings)).toBe(true)
        expect(shouldHardStop(100, { ...settings, hardStop: false })).toBe(false)
        expect(newWarnings(96, { ...settings, notifiedWarnings: [50, 80] })).toEqual([95])
    })
})
