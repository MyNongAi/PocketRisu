// How the PC split is laid out (the user's request, 2026-10-21): one bot
// list shared by both panes, placed at the start, between the panes or at
// the end; each pane with its own character panel (chat list, character,
// modules) that opens and closes on its own; side by side or one above the
// other. Kept per browser, like the split itself (chatSplitPane.ts).

import type { PaneId } from './chatPanes.svelte'
import { language } from '../lang'

export type SplitOrientation = 'row' | 'column'
export type RailPlace = 'start' | 'center' | 'end'
export type PanelTab = 'chat' | 'character' | 'module'
export type PanelEdge = 'start' | 'end'

const KEY = 'pocketrisu:split-layout'

interface SplitLayoutState {
    orientation: SplitOrientation
    railAt: RailPlace
    /** The bot list put away, for more room (the divider's menu brings it back). */
    railHidden: boolean
    panelOpen: Record<PaneId, boolean>
    /** The tab each pane's panel shows while the other pane holds the selection. */
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
        railAt: 'center',
        railHidden: false,
        panelOpen: { main: true, side: true },
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
            railAt: saved.railAt === 'start' || saved.railAt === 'end' ? saved.railAt : 'center',
            railHidden: saved.railHidden === true,
            panelOpen: { main: saved.panelOpen?.main !== false, side: saved.panelOpen?.side !== false },
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

/** Where the bot list goes: between the panes only when they sit side by side. */
export function railPlace(): RailPlace {
    return splitLayout.orientation === 'column' && splitLayout.railAt === 'center' ? 'start' : splitLayout.railAt
}

export function setSplitLayout(change: Partial<Pick<SplitLayoutState, 'orientation' | 'railAt' | 'railHidden'>>): void {
    if (change.orientation) splitLayout.orientation = change.orientation
    if (change.railAt) splitLayout.railAt = change.railAt
    if (change.railHidden !== undefined) splitLayout.railHidden = change.railHidden
    persistSplitLayout()
}

/**
 * The panes whose panels a bot list at `place` goes with: at an end, the
 * pane beside it (both when stacked, as it runs beside both); between the
 * panes, none. Closing those panels puts the list away too, and opening one
 * brings it back (the user's request, 2026-10-22).
 */
export function railPanes(place: RailPlace, orientation: SplitOrientation): PaneId[] {
    if (place === 'center') return []
    if (orientation === 'column') return ['main', 'side']
    return [place === 'start' ? 'main' : 'side']
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

/** At once, without the slide. */
export function setPanePanelOpen(pane: PaneId, open: boolean): void {
    cancelSlide('panel', pane)
    if (splitLayout.panelOpen[pane] === open) return
    splitLayout.panelOpen[pane] = open
    persistSplitLayout()
}

// A narrow window (DynamicGUI) has no room to dock the panels: each pane's
// character window covers its own chat while open, both at once if wanted
// (the user's request, 2026-10-21). Open only on request, never kept.
export const paneOverlayOpen = $state<Record<PaneId, boolean>>({ main: false, side: false })

/** At once, without the slide. */
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
