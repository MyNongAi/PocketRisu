import type { UsageBucket } from './requestLog'

export interface ModelRates {
    input?: number
    output?: number
    cachedInput?: number
    reasoning?: number
    longInput?: number
    longOutput?: number
    longCachedInput?: number
    longReasoning?: number
}

export interface CostSettings {
    rates: Record<string, ModelRates>
    budgetUsd?: number
    startDay?: string
    warnings: number[]
    hardStop: boolean
    adjustments: { day: string, amountUsd: number }[]
    notifiedWarnings: number[]
}

/** `longPrompt`: requests whose prompt is over 200k tokens; the long rates apply to them. */
export type CostBucket = UsageBucket & { model: string | null, day: string, longPrompt?: boolean }

export function defaultCostSettings(): CostSettings {
    return { rates: {}, warnings: [50, 80, 95], hardStop: true, adjustments: [], notifiedWarnings: [] }
}

const validRate = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0

export function bucketCost(bucket: CostBucket, rates: Record<string, ModelRates>):
    { amount: number | null, missingTokens: number, unpriced: boolean } {
    const missingTokens = bucket.missingTokenRequests ?? 0
    const tokens = bucket.inputTokens + bucket.outputTokens + bucket.cachedTokens + bucket.reasoningTokens
    if (tokens === 0) return { amount: null, missingTokens, unpriced: false }
    const rate = rates[bucket.model ?? '']
    const long = bucket.longPrompt === true
    const input = (long ? rate?.longInput : undefined) ?? rate?.input
    const output = (long ? rate?.longOutput : undefined) ?? rate?.output
    const cached = (long ? rate?.longCachedInput : undefined) ?? rate?.cachedInput
    const reasoning = (long ? rate?.longReasoning : undefined) ?? rate?.reasoning ?? output
    if ((bucket.inputTokens > bucket.cachedTokens && !validRate(input))
        || (bucket.outputTokens > bucket.reasoningTokens && !validRate(output))
        || (bucket.cachedTokens > 0 && !validRate(cached))
        || (bucket.reasoningTokens > 0 && !validRate(reasoning))) {
        return { amount: null, missingTokens, unpriced: true }
    }
    const amount = ((Math.max(bucket.inputTokens - bucket.cachedTokens, 0) * (input ?? 0))
        + bucket.cachedTokens * (cached ?? 0)
        + Math.max(bucket.outputTokens - bucket.reasoningTokens, 0) * (output ?? 0)
        + bucket.reasoningTokens * (reasoning ?? 0)) / 1_000_000
    return { amount, missingTokens, unpriced: false }
}

export function costSummary(buckets: CostBucket[], settings: CostSettings, today: string) {
    const relevant = buckets.filter(b => (!settings.startDay || b.day >= settings.startDay) && b.day <= today)
    const adjustment = settings.adjustments
        .filter(a => validRate(a.amountUsd) && a.day <= today && (!settings.startDay || a.day >= settings.startDay))
        .sort((a, b) => b.day.localeCompare(a.day))[0]
    let estimated = 0
    let unpriced = 0
    let missingTokens = 0
    for (const bucket of relevant) {
        missingTokens += bucket.missingTokenRequests ?? 0
        if (adjustment && bucket.day <= adjustment.day) continue
        const cost = bucketCost(bucket, settings.rates)
        estimated += cost.amount ?? 0
        if (cost.unpriced) unpriced += bucket.requests - cost.missingTokens
    }
    const spent = (adjustment?.amountUsd ?? 0) + estimated
    const budget = settings.budgetUsd
    const percent = validRate(budget) && budget > 0 ? spent / budget * 100 : null
    const remaining = percent === null ? null : Math.max(budget! - spent, 0)
    const start = settings.startDay && settings.startDay <= today ? settings.startDay : today
    const days = Math.max(1, Math.floor((Date.parse(today + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1)
    const dailyAverage = spent / days
    const daysLeft = remaining !== null && dailyAverage > 0 ? Math.ceil(remaining / dailyAverage) : null
    const depletionDay = daysLeft !== null
        ? new Date(Date.parse(today + 'T00:00:00Z') + daysLeft * 86400000).toISOString().slice(0, 10)
        : null
    return { spent, remaining, percent, dailyAverage, depletionDay, unpriced, missingTokens }
}

export function newWarnings(percent: number | null, settings: CostSettings): number[] {
    return percent === null ? [] : settings.warnings
        .filter(n => Number.isFinite(n) && n > 0 && n < 100 && percent >= n && !settings.notifiedWarnings.includes(n))
}

export function shouldHardStop(percent: number | null, settings: CostSettings): boolean {
    return settings.hardStop && percent !== null && percent >= 100
}
