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
 * Delete the shown swipe and show its neighbour (the next one, or the new
 * last one when the last was deleted). A single remaining swipe collapses back
 * to a plain message. Returns where the deleted swipe was, or null when there
 * was nothing to delete.
 */
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
