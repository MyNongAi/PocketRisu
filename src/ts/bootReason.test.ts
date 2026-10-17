// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
    sessionStorage.clear()
    vi.resetModules()
})

describe('bootReason', () => {
    it('reports how long the previous page was in the background, once', async () => {
        sessionStorage.setItem('pocketrisu-hidden-at', String(Date.now() - 95_000))
        const { bootReason } = await import('./bootReason')
        // Seconds from the mark to the module load, however long the import took.
        const hidden = Number(/hidden=(\d+)s/.exec(bootReason())?.[1])
        expect(hidden).toBeGreaterThanOrEqual(95)
        expect(hidden).toBeLessThan(160)
        expect(bootReason()).not.toContain('build-reload')
        expect(sessionStorage.getItem('pocketrisu-hidden-at')).toBeNull()
    })

    it("names a page the build fence reloaded, and remembers going hidden", async () => {
        sessionStorage.setItem('pocketrisu-stale-build-reload', 'abc-123')
        const { bootReason } = await import('./bootReason')
        expect(bootReason()).toContain('build-reload')
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
        expect(Number(sessionStorage.getItem('pocketrisu-hidden-at'))).toBeGreaterThan(0)
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
        document.dispatchEvent(new Event('visibilitychange'))
        expect(sessionStorage.getItem('pocketrisu-hidden-at')).toBeNull()
    })
})
