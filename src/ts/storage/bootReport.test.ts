import { afterEach, describe, expect, test, vi } from 'vitest'

const addLog = vi.fn()
vi.mock('../log', () => ({ addLog }))

const { expectBaselineHash, finishBootReport, formatBootReport, markBootPhase, resetBootReportForTests } = await import('./bootReport')
const { resetBootSettledForTests, whenBootSettled } = await import('./bootSettled')

describe('boot report', () => {
    afterEach(() => {
        resetBootReportForTests()
        addLog.mockReset()
    })

    test('formats a delta boot with phase timings and no content', () => {
        const marks = new Map([['start', 1000], ['fetched', 4100], ['decoded', 6900], ['loaded', 10000], ['saverReady', 12000]] as const)
        const line = formatBootReport(new Map(marks), {
            mode: 'boot', fallbackReason: null, total: 267_200_000, received: 1_200_000, segments: 2446, cachedSegments: 2434, ms: 3050,
        })
        expect(line).toBe('[Boot] delta 1.1MB of 254.8MB (12/2446 segments downloaded) in 3.05s · fetch 3.10s · decode 2.80s · ui 3.10s · saver 2.00s · total 11.00s')
    })

    test('formats a full read and its fallback reason', () => {
        const line = formatBootReport(new Map(), {
            mode: 'read', fallbackReason: 'unavailable', total: 1024 * 1024, received: 1024 * 1024, segments: null, cachedSegments: null, ms: 900,
        })
        expect(line).toBe('[Boot] full read 1.0MB (fallback: unavailable) in 0.90s')
    })

    test('a baseline hash that differs from x-db-hash is logged and suspends the cache', () => {
        markBootPhase('start')
        expectBaselineHash('b81a7509')
        const onHashMismatch = vi.fn()
        finishBootReport({ baselineHash: () => '1234abcd', load: null, onHashMismatch })
        expect(onHashMismatch).toHaveBeenCalledWith('b81a7509', '1234abcd')
        expect(addLog).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', source: 'boot' }))
        expect(addLog).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'info', message: expect.stringMatching(/^\[Boot\] /) }))
    })

    test('matching hashes, a baseline not from the boot bytes, or no x-db-hash skip the check', () => {
        const onHashMismatch = vi.fn()
        expectBaselineHash('b81a7509')
        finishBootReport({ baselineHash: () => 'B81A7509', load: null, onHashMismatch })
        resetBootReportForTests()

        expectBaselineHash('b81a7509')
        finishBootReport({ baselineHash: null, load: null, onHashMismatch })
        resetBootReportForTests()

        const hash = vi.fn(() => '1234abcd')
        expectBaselineHash(null)
        finishBootReport({ baselineHash: hash, load: null, onHashMismatch })
        expect(hash).not.toHaveBeenCalled()
        expect(onHashMismatch).not.toHaveBeenCalled()
        expect(addLog.mock.calls.every(([entry]) => entry.level === 'info')).toBe(true)
    })

    test('reports once per page and never throws', () => {
        const onHashMismatch = vi.fn()
        expectBaselineHash('b81a7509')
        expect(() => finishBootReport({ baselineHash: () => { throw new Error('boom') }, load: null, onHashMismatch })).not.toThrow()
        finishBootReport({ baselineHash: () => '0', load: null, onHashMismatch })
        expect(onHashMismatch).not.toHaveBeenCalled()
    })

    test('the saver-ready mark settles boot, so a waiting cache commit can start', async () => {
        let settled = false
        void whenBootSettled(60_000).then(() => { settled = true })
        markBootPhase('loaded')
        await Promise.resolve()
        expect(settled).toBe(false)
        finishBootReport({ baselineHash: null, load: null, onHashMismatch: vi.fn() })
        await vi.waitFor(() => expect(settled).toBe(true))
    })
})
