// The newest reply's ‹ page › ↻ row, floated at the bottom right while the
// reader is below it in a long reply (the user's request, 2026-10-31): the
// row sits at the reply's top, beside the name, and scrolled away with it.
// DefaultChatScreen draws the copy; Chats.svelte hands it what the row does.

/** What the newest reply's row does, as Chats.svelte draws it. */
export type NewestReplyControls = {
    /** The reply's place in the list (its data-chat-slot). */
    slot: number
    currentPage: number
    totalPages: number
    prev: () => void
    next: () => void
    /** Null while the reply is being rerolled: its row only browses then. */
    reroll: (() => void) | null
}

/** The row's arrows and ↻ in a reply (Chat.svelte's rerolls snippet; a reply may show it at its top and its end). */
export const REPLY_ROW_BUTTONS = '.button-icon-unreroll, .button-icon-swipe-next, .button-icon-reroll'

type Span = { top: number, bottom: number }

/**
 * The copy shows while none of the reply's row buttons is in the view (the
 * part the composer does not cover) and the reply still fills `minVisible`
 * px of it: past the reply, there is no page to turn.
 */
export function floatingSwipeShows(rows: readonly Span[], reply: Span, view: Span, minVisible = 48): boolean {
    if (rows.length === 0) return false
    if (rows.some((row) => row.bottom > view.top && row.top < view.bottom)) return false
    return Math.min(reply.bottom, view.bottom) - Math.max(reply.top, view.top) >= minVisible
}

const BUTTON = 36 // the scroll buttons' w-9 / h-9
const GAP = 8
const BOTTOM = 64 // bottom-16, where the scroll buttons and the new message button sit

/**
 * The copy's bottom offset in px: clear of the composer where it shows
 * (`composerCover`, px of the view it covers), and above the scroll buttons
 * when those sit at the bottom.
 */
export function floatingSwipeBottom(scrollButtons: string | undefined, position: string | undefined, composerCover = 0): number {
    const bottom = Math.max(BOTTOM, composerCover + GAP)
    if (scrollButtons === 'off') return bottom
    if (position === 'right-bottom') return bottom + BUTTON * 2 + GAP
    if (position === 'bottom-center') return bottom + BUTTON + GAP
    return bottom
}
