import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// The split's layout state: where each pane's panel comes out, which panels
// the bot list goes with, and the slide before a panel closes (the user's
// requests, 2026-10-22).
const KEY = 'pocketrisu:split-layout'

async function load(saved?: unknown) {
    vi.resetModules()
    localStorage.clear()
    if (saved !== undefined) localStorage.setItem(KEY, JSON.stringify(saved))
    return await import('./splitLayout.svelte')
}

describe('panel edges', () => {
    test("the left pane's panel comes out of the left, the right one's out of the right", async () => {
        const { splitLayout } = await load()
        expect(splitLayout.panelEdge).toEqual({ main: 'start', side: 'end' })
    })

    test('a choice is kept, and a bad saved value falls back', async () => {
        const first = await load()
        first.setPanelEdge('side', 'start')
        first.setPanelEdge('main', 'end')
        const saved = JSON.parse(localStorage.getItem(KEY)!)
        expect(saved.panelEdge).toEqual({ main: 'end', side: 'start' })

        const again = await load(saved)
        expect(again.splitLayout.panelEdge).toEqual({ main: 'end', side: 'start' })

        const broken = await load({ panelEdge: { main: 'middle' } })
        expect(broken.splitLayout.panelEdge).toEqual({ main: 'start', side: 'end' })
    })
})

describe('the bot list goes with the panel beside it', () => {
    test('at an end, the pane beside it; stacked, both; between the panes, none', async () => {
        const { railPanes } = await load()
        expect(railPanes('start', 'row')).toEqual(['main'])
        expect(railPanes('end', 'row')).toEqual(['side'])
        expect(railPanes('center', 'row')).toEqual([])
        expect(railPanes('start', 'column')).toEqual(['main', 'side'])
        expect(railPanes('end', 'column')).toEqual(['main', 'side'])
    })
})

describe('closing slides first', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
        document.documentElement.style.removeProperty('--risu-animation-speed')
    })

    test('a panel stays open while it slides out, then closes', async () => {
        document.documentElement.style.setProperty('--risu-animation-speed', '0.2s')
        const layout = await load()
        layout.closePanePanel('side')
        expect(layout.paneClosing.panel.side).toBe(true)
        expect(layout.splitLayout.panelOpen.side).toBe(true)
        vi.advanceTimersByTime(200)
        expect(layout.paneClosing.panel.side).toBe(false)
        expect(layout.splitLayout.panelOpen.side).toBe(false)
    })

    test('the arrow pressed again while it slides keeps it open', async () => {
        document.documentElement.style.setProperty('--risu-animation-speed', '0.2s')
        const layout = await load()
        layout.togglePanePanel('main')
        expect(layout.paneClosing.panel.main).toBe(true)
        layout.togglePanePanel('main')
        expect(layout.paneClosing.panel.main).toBe(false)
        vi.advanceTimersByTime(500)
        expect(layout.splitLayout.panelOpen.main).toBe(true)
    })

    test('with animations off it closes at once', async () => {
        document.documentElement.style.setProperty('--risu-animation-speed', '0s')
        const layout = await load()
        layout.closePanePanel('main')
        expect(layout.paneClosing.panel.main).toBe(false)
        expect(layout.splitLayout.panelOpen.main).toBe(false)
    })

    test("a narrow window's overlay slides out too; opening it again cancels that", async () => {
        document.documentElement.style.setProperty('--risu-animation-speed', '0.2s')
        const layout = await load()
        layout.setPaneOverlayOpen('side', true)
        layout.closePaneOverlay('side')
        expect(layout.paneClosing.overlay.side).toBe(true)
        expect(layout.paneOverlayOpen.side).toBe(true)
        layout.setPaneOverlayOpen('side', true)
        vi.advanceTimersByTime(500)
        expect(layout.paneOverlayOpen.side).toBe(true)
        layout.closePaneOverlay('side')
        vi.advanceTimersByTime(200)
        expect(layout.paneOverlayOpen.side).toBe(false)
    })
})
