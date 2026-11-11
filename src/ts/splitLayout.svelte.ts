// How the PC split is laid out (the user's request, 2026-10-21): each pane
// with its own character panel (chat list, character, modules); side by side
// or one above the other. Kept per browser, like the split itself
// (chatSplitPane.ts).
//
// Since 2026-10-27 each panel has brought its own bot list, so opening one
// closed the other. Each list now has its own toggle (2026-11-12), and both
// panels or narrow-window overlays may stay open.

import type { PaneId } from './chatPanes.svelte'
import { language } from '../lang'

export type SplitOrientation = 'row' | 'column'
export type PanelTab = 'chat' | 'character' | 'module'
export type PanelEdge = 'start' | 'end'

const KEY = 'pocketrisu:split-layout'

interface SplitLayoutState {
    orientation: SplitOrientation
    panelOpen: Record<PaneId, boolean>
    /** The tab each pane's panel shows. */
    tab: Record<PaneId, PanelTab>
    /**
     * The edge of its pane each pane's panel comes out of (the divider's
     * menu; the user's request, 2026-10-22): the left pane's at the left, the
     * right one's at the right, unless changed.
     */
    panelEdge: Record<PaneId, PanelEdge>
}

function read(): SplitLayoutState {
    const fallback: SplitLayoutState = {
        orientation: 'row',
        panelOpen: { main: true, side: false },
        tab: { main: 'chat', side: 'chat' },
        panelEdge: { main: 'start', side: 'end' },
    }
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null')
        if (!saved || typeof saved !== 'object') return fallback
        const tab = (value: unknown): PanelTab => value === 'character' || value === 'module' ? value : 'chat'
        const edge = (value: unknown, fallback: PanelEdge): PanelEdge => value === 'start' || value === 'end' ? value : fallback
        return {
            orientation: saved.orientation === 'column' ? 'column' : 'row',
            panelOpen: { main: saved.panelOpen?.main !== false, side: saved.panelOpen?.side === true },
            tab: { main: tab(saved.tab?.main), side: tab(saved.tab?.side) },
            panelEdge: { main: edge(saved.panelEdge?.main, 'start'), side: edge(saved.panelEdge?.side, 'end') },
        }
    } catch {
        return fallback
    }
}

export const splitLayout = $state(read())

export function persistSplitLayout(): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(splitLayout))
    } catch {
        // best effort
    }
}

export function setSplitLayout(change: Partial<Pick<SplitLayoutState, 'orientation'>>): void {
    if (change.orientation) splitLayout.orientation = change.orientation
    persistSplitLayout()
}

export function setPanelEdge(pane: PaneId, edge: PanelEdge): void {
    if (splitLayout.panelEdge[pane] === edge) return
    splitLayout.panelEdge[pane] = edge
    persistSplitLayout()
}

// A pane's panel, or a narrow window's overlay, slides out before it closes,
// as the app's own sidebar does. The panes lost the slide when they got
// their own panels (2026-10-21; the user's report, 2026-10-22). Not kept.
export type SlideKind = 'panel' | 'overlay'
export const paneClosing = $state<Record<SlideKind, Record<PaneId, boolean>>>({
    panel: { main: false, side: false },
    overlay: { main: false, side: false },
})
const slideTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** The app's animation speed (Settings), in ms; 0 closes at once. */
export function slideMs(): number {
    try {
        const seconds = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--risu-animation-speed'))
        return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
    } catch {
        return 0
    }
}

function cancelSlide(kind: SlideKind, pane: PaneId): void {
    const key = `${kind}:${pane}`
    const timer = slideTimers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    slideTimers.delete(key)
    paneClosing[kind][pane] = false
}

// The slide out runs for the animation's length (SplitWorkspace's CSS), then it closes.
function slideShut(kind: SlideKind, pane: PaneId, close: () => void): void {
    const key = `${kind}:${pane}`
    if (slideTimers.has(key)) return
    const ms = slideMs()
    if (ms === 0) {
        close()
        return
    }
    paneClosing[kind][pane] = true
    slideTimers.set(key, setTimeout(() => {
        slideTimers.delete(key)
        paneClosing[kind][pane] = false
        close()
    }, ms))
}

export function togglePanePanel(pane: PaneId): void {
    if (splitLayout.panelOpen[pane] && !paneClosing.panel[pane]) closePanePanel(pane)
    else setPanePanelOpen(pane, true)
}

/** Slides the pane's panel shut. */
export function closePanePanel(pane: PaneId): void {
    if (!splitLayout.panelOpen[pane]) return
    slideShut('panel', pane, () => setPanePanelOpen(pane, false))
}

/** At once, without the slide. Each pane keeps its own open state. */
export function setPanePanelOpen(pane: PaneId, open: boolean): void {
    cancelSlide('panel', pane)
    if (splitLayout.panelOpen[pane] === open) {
        persistSplitLayout()
        return
    }
    splitLayout.panelOpen[pane] = open
    persistSplitLayout()
}

// A narrow window (DynamicGUI) has no room to dock the panels: a pane's
// character window, with the bot list, covers its own chat while open (the
// user's request, 2026-10-21). Each pane opens on request; neither is kept.
export const paneOverlayOpen = $state<Record<PaneId, boolean>>({ main: false, side: false })

/** At once, without the slide. Each overlay keeps its own open state. */
export function setPaneOverlayOpen(pane: PaneId, open: boolean): void {
    cancelSlide('overlay', pane)
    paneOverlayOpen[pane] = open
}

/** Slides the pane's overlay shut. */
export function closePaneOverlay(pane: PaneId): void {
    if (!paneOverlayOpen[pane]) return
    slideShut('overlay', pane, () => setPaneOverlayOpen(pane, false))
}

/** The words for the two panes in menus: left/right side by side, top/bottom stacked. */
export function paneWord(pane: PaneId): string {
    const words = language.splitPaneWords
    if (splitLayout.orientation === 'column') return pane === 'main' ? words.top : words.bottom
    return pane === 'main' ? words.left : words.right
}
