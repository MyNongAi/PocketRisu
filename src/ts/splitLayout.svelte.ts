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

const KEY = 'pocketrisu:split-layout'

interface SplitLayoutState {
    orientation: SplitOrientation
    railAt: RailPlace
    panelOpen: Record<PaneId, boolean>
    /** The tab each pane's panel shows while the other pane holds the selection. */
    tab: Record<PaneId, PanelTab>
}

function read(): SplitLayoutState {
    const fallback: SplitLayoutState = {
        orientation: 'row',
        railAt: 'center',
        panelOpen: { main: true, side: true },
        tab: { main: 'chat', side: 'chat' },
    }
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null')
        if (!saved || typeof saved !== 'object') return fallback
        const tab = (value: unknown): PanelTab => value === 'character' || value === 'module' ? value : 'chat'
        return {
            orientation: saved.orientation === 'column' ? 'column' : 'row',
            railAt: saved.railAt === 'start' || saved.railAt === 'end' ? saved.railAt : 'center',
            panelOpen: { main: saved.panelOpen?.main !== false, side: saved.panelOpen?.side !== false },
            tab: { main: tab(saved.tab?.main), side: tab(saved.tab?.side) },
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

export function setSplitLayout(change: Partial<Pick<SplitLayoutState, 'orientation' | 'railAt'>>): void {
    if (change.orientation) splitLayout.orientation = change.orientation
    if (change.railAt) splitLayout.railAt = change.railAt
    persistSplitLayout()
}

export function togglePanePanel(pane: PaneId): void {
    splitLayout.panelOpen[pane] = !splitLayout.panelOpen[pane]
    persistSplitLayout()
}

export function setPanePanelOpen(pane: PaneId, open: boolean): void {
    if (splitLayout.panelOpen[pane] === open) return
    splitLayout.panelOpen[pane] = open
    persistSplitLayout()
}

// A narrow window (DynamicGUI) has no room to dock the panels: each pane's
// character window covers its own chat while open, both at once if wanted
// (the user's request, 2026-10-21). Open only on request, never kept.
export const paneOverlayOpen = $state<Record<PaneId, boolean>>({ main: false, side: false })

export function setPaneOverlayOpen(pane: PaneId, open: boolean): void {
    paneOverlayOpen[pane] = open
}

/** The words for the two panes in menus: left/right side by side, top/bottom stacked. */
export function paneWord(pane: PaneId): string {
    const words = language.splitPaneWords
    if (splitLayout.orientation === 'column') return pane === 'main' ? words.top : words.bottom
    return pane === 'main' ? words.left : words.right
}
