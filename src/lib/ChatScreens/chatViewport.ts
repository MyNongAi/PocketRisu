// Rules of the chat viewport (see "Viewport" in Chats.svelte).
// The chat scroller is top-origin: scrollTop 0 is the oldest loaded message
// and the live tail (newest message, then the composer) is at the far end, so
// text streaming into the newest reply grows below what the reader sees.

export const TAIL_THRESHOLD = 100

export type ScrollBox = {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
}

/** Pixels between the bottom of the view and the live tail. */
export function distanceFromTail(box: ScrollBox): number {
    return box.scrollHeight - box.clientHeight - box.scrollTop
}

export function isAtTail(box: ScrollBox, threshold = TAIL_THRESHOLD): boolean {
    return distanceFromTail(box) <= threshold
}

/**
 * scrollTop that shows a message just added at the tail: toward the tail, but
 * never past the message's first line (`newestTop`, in scroll coordinates),
 * and never back up.
 */
export function revealScrollTop(box: ScrollBox, newestTop: number): number {
    const tail = box.scrollHeight - box.clientHeight
    return Math.max(box.scrollTop, Math.min(tail, newestTop))
}

/**
 * Whether a resize should keep the view at the tail. When only the transcript
 * grew (streamed text, a remount settling) the view follows only if the reader
 * opted into auto-scroll; a resized viewport (mobile keyboard) or composer
 * keeps a reader who was at the tail there.
 */
export function shouldFollowTail(state: {
    pinnedToTail: boolean
    readerAtTail: boolean
    onlyTranscriptResized: boolean
    autoScroll: boolean
}): boolean {
    return state.pinnedToTail
        || (state.readerAtTail && (!state.onlyTranscriptResized || state.autoScroll))
}

/** Whether a newly added message is revealed (once, when it is added). */
export function shouldRevealAddedMessage(state: {
    wasAtTail: boolean
    role: string | undefined
    autoScroll: boolean
    alwaysScroll: boolean
}): boolean {
    return state.wasAtTail || state.role === 'user' || (state.autoScroll && state.alwaysScroll)
}

/** Older pages load when the reader nears the top, where the oldest message is. */
export function shouldLoadOlderPages(box: ScrollBox, loaded: number, total: number, threshold = 100): boolean {
    return box.scrollTop < threshold && total > loaded
}
