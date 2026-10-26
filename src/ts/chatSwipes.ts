// Swipe navigation on a single message, independent of where it sits in the
// chat. Every reply keeps its swipes (message.swipes / swipeId); the newest
// reply is the reroll target, older replies can only be browsed.

export interface SwipeMessage {
    role?: string
    data: string
    swipes?: string[]
    swipeId?: number
    isComment?: boolean
    disabled?: unknown
    /** Swipe index of a reply that looked like an error (isErrorLikeReply). */
    nodeOnlyErrorSwipe?: number
    /** Swipe index of a reply a reroll added while another page stayed shown, until it is seen. */
    nodeOnlyNewSwipe?: number
}

// A reply that arrives within 10 s with 100 characters or fewer is usually a
// provider error, not a real answer (the user's rule, 2026-10-17): it keeps
// no swipe page once the user moves off it or rerolls it.
export const ERROR_LIKE_REPLY_MS = 10_000
export const ERROR_LIKE_REPLY_CHARS = 100

export function isErrorLikeReply(text: string | undefined, elapsedMs: number): boolean {
    return elapsedMs < ERROR_LIKE_REPLY_MS && (text ?? '').trim().length <= ERROR_LIKE_REPLY_CHARS
}

/** Mark (or unmark) the shown swipe of a reply that just finished generating. */
export function markErrorLikeReply(message: SwipeMessage, elapsedMs: number): void {
    const shown = message.swipeId ?? 0
    if (isErrorLikeReply(message.data, elapsedMs)) message.nodeOnlyErrorSwipe = shown
    else if (message.nodeOnlyErrorSwipe === shown) delete message.nodeOnlyErrorSwipe
}

/** The shown swipe is a marked error-like reply (still short, so not edited into a real one). */
export function shownSwipeIsErrorLike(message: SwipeMessage): boolean {
    return message.nodeOnlyErrorSwipe !== undefined
        && message.nodeOnlyErrorSwipe === (message.swipeId ?? 0)
        && (message.data ?? '').trim().length <= ERROR_LIKE_REPLY_CHARS
}

/** Keep the error mark on the same swipe after swipe `removedIndex` was deleted. */
export function shiftErrorMarkAfterDelete(message: SwipeMessage, removedIndex: number): void {
    const mark = message.nodeOnlyErrorSwipe
    if (mark === undefined) return
    if (mark === removedIndex || !Array.isArray(message.swipes)) delete message.nodeOnlyErrorSwipe
    else if (mark > removedIndex) message.nodeOnlyErrorSwipe = mark - 1
}

// A reroll that finishes while the chat is open keeps the page that was shown
// (rerollPlaceholder.ts), so the new reply waits on a later page. Its arrow
// shows a dot until that page is seen (the user's request, 2026-10-21).

/** Mark swipe `index` as added by a reroll and not seen yet (no mark when it is the shown one). */
export function markNewSwipe(message: SwipeMessage, index: number): void {
    if (Array.isArray(message.swipes) && index >= 0 && index < message.swipes.length && index !== (message.swipeId ?? 0)) {
        message.nodeOnlyNewSwipe = index
    }
}

/** Seeing the marked page drops the mark. */
export function seeShownSwipe(message: SwipeMessage): void {
    if (message.nodeOnlyNewSwipe !== undefined && message.nodeOnlyNewSwipe === (message.swipeId ?? 0)) delete message.nodeOnlyNewSwipe
}

/** A page a reroll added is waiting unseen. */
export function hasUnseenSwipe(message: SwipeMessage | null | undefined): boolean {
    const mark = message?.nodeOnlyNewSwipe
    return mark !== undefined && Array.isArray(message?.swipes) && mark < message.swipes.length && mark !== (message.swipeId ?? 0)
}

// A waiting reply of 300 characters or fewer is likely cut short or an error:
// its arrow is red instead of green (the user's request, 2026-10-26).
export const SHORT_NEW_REPLY_CHARS = 300

/** The page a reroll added is waiting unseen and holds a short reply. */
export function unseenSwipeIsShort(message: SwipeMessage | null | undefined): boolean {
    if (!message || !hasUnseenSwipe(message)) return false
    return (message.swipes?.[message.nodeOnlyNewSwipe ?? -1] ?? '').trim().length <= SHORT_NEW_REPLY_CHARS
}

/** Keep the new-page mark on the same swipe after swipe `removedIndex` was deleted. */
export function shiftNewMarkAfterDelete(message: SwipeMessage, removedIndex: number): void {
    const mark = message.nodeOnlyNewSwipe
    if (mark === undefined) return
    if (mark === removedIndex || !Array.isArray(message.swipes)) delete message.nodeOnlyNewSwipe
    else if (mark > removedIndex) message.nodeOnlyNewSwipe = mark - 1
}

/**
 * Index of the reply the reroll controls act on: the last message that is
 * neither a comment nor disabled, when it is the character's; -1 otherwise
 * (e.g. the chat ends on the user's turn).
 */
export function findRerollTargetIndex(messages: readonly SwipeMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (!message || message.isComment || message.disabled) continue
        return message.role === 'char' ? i : -1
    }
    return -1
}

/**
 * Index of the newest reply: the last character message that is neither a
 * comment nor disabled, even when the user spoke after it; -1 when there is
 * none. Its swipes carry the chat-variable checkpoint, so showing another of
 * them restores the variables (chatScriptstateCheckpoint.ts).
 */
export function findLastReplyIndex(messages: readonly (SwipeMessage | null | undefined)[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message && message.role === 'char' && !message.isComment && !message.disabled) return i
    }
    return -1
}

/** Number of swipes the message can be browsed through (0 or 1 = none). */
export function swipeCount(message: SwipeMessage | null | undefined): number {
    return Array.isArray(message?.swipes) ? message.swipes.length : 0
}

/** Older replies show the swipe arrows only when there is something to browse. */
export function hasBrowsableSwipes(message: SwipeMessage | null | undefined): boolean {
    return message?.role === 'char' && swipeCount(message) > 1
}

/** `index` wrapped into 0..count-1 (both directions). */
export function wrapSwipeIndex(index: number, count: number): number {
    if (count <= 0) return 0
    return ((Math.trunc(index) % count) + count) % count
}

/**
 * Show the previous (-1) or next (+1) swipe, wrapping at both ends. Returns
 * false when the message has no swipes to switch between.
 */
export function stepSwipe(message: SwipeMessage, step: -1 | 1): boolean {
    const swipes = message.swipes
    if (!Array.isArray(swipes) || swipes.length === 0 || message.swipeId === undefined) return false
    message.swipeId = wrapSwipeIndex(message.swipeId + step, swipes.length)
    message.data = swipes[message.swipeId]
    return true
}

/**
 * Show swipe `index` directly (the branch graph jumps to one). Returns false
 * when the message has no such swipe.
 */
export function showSwipe(message: SwipeMessage, index: number): boolean {
    const swipes = message.swipes
    if (!Array.isArray(swipes) || !Number.isInteger(index) || index < 0 || index >= swipes.length) return false
    message.swipeId = index
    message.data = swipes[index]
    return true
}

/**
 * Delete the shown swipe and show its neighbour (the next one, or the new
 * last one when the last was deleted). A single remaining swipe collapses back
 * to a plain message. Returns where the deleted swipe was, or null when there
 * was nothing to delete.
 */
/**
 * Delete the shown swipe and show its neighbour in the `step` direction
 * (wrapping like stepSwipe): moving back off a dropped page lands on the one
 * before it.
 */
export function dropShownSwipe(message: SwipeMessage, step: -1 | 1): { removedIndex: number, previousCount: number } | null {
    const removed = deleteShownSwipe(message)
    if (!removed) return null
    if (Array.isArray(message.swipes)) {
        showSwipe(message, wrapSwipeIndex(step === -1 ? removed.removedIndex - 1 : removed.removedIndex, message.swipes.length))
    }
    return removed
}

export function deleteShownSwipe(message: SwipeMessage): { removedIndex: number, previousCount: number } | null {
    const swipes = message.swipes
    if (!Array.isArray(swipes) || swipes.length <= 1) return null
    const previousCount = swipes.length
    const removedIndex = Math.min(Math.max(0, Math.trunc(message.swipeId ?? 0) || 0), previousCount - 1)
    swipes.splice(removedIndex, 1)
    message.swipeId = Math.min(removedIndex, swipes.length - 1)
    message.data = swipes[message.swipeId]
    if (swipes.length === 1) {
        delete message.swipes
        delete message.swipeId
    }
    return { removedIndex, previousCount }
}
