// One [Boot] log line per page load: how database.bin arrived (delta boot or
// full read, bytes received) and how long each loadData phase took. The
// phone's decode, $state, plugin and render costs cannot be measured in Node,
// so these lines are how boot time is measured in the field. The line holds
// only sizes, counts and timings.
//
// It also runs the x-db-hash cross-check: once saveDb has seeded its patcher
// from the bytes boot fetched, patcher.hash() must equal the server's hash of
// the view it served. The bytes were verified segment by segment, so a
// mismatch points at a bug; it is logged and the boot cache is suspended.

import { addLog } from '../log'
import type { DbLoadInfo } from './nodeStorage'

export type BootPhase = 'start' | 'fetched' | 'decoded' | 'loaded' | 'saverReady'

const PHASES: BootPhase[] = ['start', 'fetched', 'decoded', 'loaded', 'saverReady']
const PHASE_LABELS: Record<Exclude<BootPhase, 'start'>, string> = {
    fetched: 'fetch',
    decoded: 'decode',
    loaded: 'ui',
    saverReady: 'saver',
}

const marks = new Map<BootPhase, number>()
let expectedBaselineHash: string | null = null
let reported = false

/** Record when a loadData phase ended (first call per phase wins). */
export function markBootPhase(phase: BootPhase): void {
    if (marks.has(phase)) return
    marks.set(phase, performance.now())
    try {
        performance.mark(`pocketrisu-boot:${phase}`)
    } catch { /* User Timing unavailable */ }
}

/**
 * The server's hash of the view the patch baseline was decoded from, or null
 * when the baseline did not come from the fetched bytes (fresh database,
 * backup, old server without x-db-hash).
 */
export function expectBaselineHash(hash: string | null): void {
    expectedBaselineHash = hash
}

function formatBytes(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function formatSeconds(ms: number): string {
    return `${(ms / 1000).toFixed(2)}s`
}

export function formatBootReport(timings: Map<BootPhase, number>, load: DbLoadInfo | null): string {
    const parts: string[] = []
    if (!load) {
        parts.push('database not read')
    } else if (load.mode === 'boot') {
        const segments = load.segments !== null && load.cachedSegments !== null
            ? ` (${load.segments - load.cachedSegments}/${load.segments} segments downloaded)`
            : ''
        parts.push(`delta ${formatBytes(load.received)} of ${formatBytes(load.total)}${segments} in ${formatSeconds(load.ms)}`)
    } else {
        const fallback = load.fallbackReason ? ` (fallback: ${load.fallbackReason})` : ''
        parts.push(`full read ${formatBytes(load.total)}${fallback} in ${formatSeconds(load.ms)}`)
    }
    const start = timings.get('start')
    if (start !== undefined) {
        let previous = start
        for (const phase of PHASES) {
            if (phase === 'start') continue
            const at = timings.get(phase)
            if (at === undefined) continue
            parts.push(`${PHASE_LABELS[phase]} ${formatSeconds(at - previous)}`)
            previous = at
        }
        const end = timings.get('saverReady') ?? timings.get('loaded')
        if (end !== undefined) parts.push(`total ${formatSeconds(end - start)}`)
    }
    return `[Boot] ${parts.join(' · ')}`
}

/**
 * Called once, by saveDb after its patcher is ready. `baselineHash` reads
 * patcher.hash() when the patcher was seeded from the boot baseline; it is
 * null otherwise. Never throws: saving must start whatever happens here.
 */
export function finishBootReport(options: {
    baselineHash: (() => string) | null
    load: DbLoadInfo | null
    onHashMismatch: (expected: string, actual: string) => void
}): void {
    if (reported) return
    reported = true
    try {
        markBootPhase('saverReady')
        const expected = expectedBaselineHash
        expectedBaselineHash = null
        const actual = expected && options.baselineHash ? options.baselineHash().toLowerCase() : null
        if (expected && actual && expected !== actual) {
            addLog({
                level: 'error',
                source: 'boot',
                message: `[Boot] Patch baseline hash ${actual} differs from the server's x-db-hash ${expected}; boot cache suspended`,
            })
            options.onHashMismatch(expected, actual)
        }
        addLog({ level: 'info', source: 'boot', message: formatBootReport(marks, options.load) })
    } catch (error) {
        console.warn('[Boot] Boot report failed:', error)
    }
}

/** Tests only: forget the marks and the once-per-page guard. */
export function resetBootReportForTests(): void {
    marks.clear()
    expectedBaselineHash = null
    reported = false
}
