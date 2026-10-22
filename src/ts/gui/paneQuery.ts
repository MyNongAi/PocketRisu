// Element lookups for keyboard shortcuts (hotkey.ts). With the split screen
// both panes draw the same buttons, and the main pane comes first in the
// page: document.querySelector found the left pane's send button while the
// user typed in the right one, and a programmatic click does not move the
// selection, so the left chat was sent (2026-10-22 split review).
import { paneState } from '../chatPanes.svelte'

/**
 * The first match inside the pane holding the selection, or outside every
 * pane; none from the other pane. With one pane on the page (no split, or the
 * active pane not drawn) this is document.querySelector.
 */
export function queryInActivePane<T extends Element = HTMLElement>(selector: string, doc: Document = document): T | null {
    const active = doc.querySelector(`[data-chat-pane="${paneState.active}"]`)
    const panes = doc.querySelectorAll('[data-chat-pane]')
    if (!active || panes.length < 2) return doc.querySelector<T>(selector)
    for (const element of doc.querySelectorAll<T>(selector)) {
        const pane = element.closest('[data-chat-pane]')
        if (!pane || pane === active) return element
    }
    return null
}
