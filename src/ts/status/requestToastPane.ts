// Where a request's card shows while the PC split is on (the user's report,
// 2026-10-22: every card came up over the left pane, a leftover of the days
// the right pane was the whole app again in an iframe with its own toasts).
// A reply written for a chat on screen gets its card over that chat's pane
// (PaneToasters.svelte); any other toast keeps the window's top right.

import { get } from 'svelte/store'
import { isEmbeddedRisuPane, splitChatOpen } from '../chatSplitPane'
import { mainPaneView, sidePaneView, type PaneId } from '../chatPanes.svelte'
import { MobileGUI } from '../stores.svelte'

export const PANE_TOASTERS: Record<PaneId, string> = { main: 'pane-main', side: 'pane-side' }

/** Both panes are on screen (SplitWorkspace's `enabled`). */
export function splitPanesShown(): boolean {
    return get(splitChatOpen) && !get(MobileGUI) && !isEmbeddedRisuPane
}

/** The toaster of the pane showing `chatId`, or undefined for the window's own. */
export function paneToasterFor(chatId: string | null | undefined): string | undefined {
    if (!chatId || !splitPanesShown()) return undefined
    if (sidePaneView.chat?.id === chatId) return PANE_TOASTERS.side
    if (mainPaneView.chat?.id === chatId) return PANE_TOASTERS.main
    return undefined
}
