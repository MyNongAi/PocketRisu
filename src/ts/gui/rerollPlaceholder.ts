// While a reply is rerolled, the old one stays on screen until the new one
// shows text (the user's request, 2026-10-09): pressing reroll used to blank
// the end of the chat for the whole wait. The chat itself already holds the
// messages without it (the prompt is built from them, unchanged); this only
// tells the chat list what to draw at its place meanwhile, and lets its swipes
// be browsed. Once the new reply has text, or the reroll ends either way, the
// copy goes.
//
// A held copy (the user's request, 2026-10-19) stays for the whole reroll,
// and the reply shown when reroll was pressed stays shown after it, while the
// chat is open: the new reply is the next page, seen by stepping to it. The
// copy counts it as one more page; stepping onto that page lets it show.
import { get, writable } from 'svelte/store'
import { stepSwipe, swipeCount, type SwipeMessage } from '../chatSwipes'

export type RerollPlaceholder<M extends SwipeMessage = SwipeMessage> = {
    /** The chat being rerolled. */
    chatId: string
    /** Where the new reply goes: the old one's place. */
    index: number
    /** A copy of the old reply; browsing its swipes changes only the copy. */
    message: M
    /** Stays until the reroll ends, and the page it shows stays shown after. */
    hold?: boolean
}

export const rerollPlaceholders = writable<ReadonlyMap<string, RerollPlaceholder<any>>>(new Map())

export function setRerollPlaceholder<M extends SwipeMessage>(placeholder: RerollPlaceholder<M>): void {
    rerollPlaceholders.update((current) => new Map(current).set(placeholder.chatId, placeholder))
}

export function clearRerollPlaceholder(chatId: string): void {
    if (!get(rerollPlaceholders).has(chatId)) return
    rerollPlaceholders.update((current) => {
        const next = new Map(current)
        next.delete(chatId)
        return next
    })
}

/** The copy's page and page count; a held copy counts the new reply as one more. */
export function rerollPlaceholderPages(placeholder: Pick<RerollPlaceholder, 'message' | 'hold'>): { current: number, total: number } {
    return {
        current: (placeholder.message.swipeId ?? 0) + 1,
        total: Math.max(1, swipeCount(placeholder.message)) + (placeholder.hold ? 1 : 0),
    }
}

/** The page a held copy shows (to stay shown after the reroll), or null. */
export function heldRerollSwipe(chatId: string): number | null {
    const placeholder = get(rerollPlaceholders).get(chatId)
    return placeholder?.hold ? (placeholder.message.swipeId ?? 0) : null
}

/** Show the copy's previous (-1) or next (+1) swipe. False when it has none. */
export function stepRerollPlaceholderSwipe(chatId: string, step: -1 | 1): boolean {
    const placeholder = get(rerollPlaceholders).get(chatId)
    if (!placeholder) return false
    if (placeholder.hold) {
        // Past either end is the new reply's page: let it show.
        const { current, total } = rerollPlaceholderPages(placeholder)
        if ((step === 1 && current === total - 1) || (step === -1 && current === 1)) {
            setRerollPlaceholder({ ...placeholder, hold: false })
            return true
        }
    }
    const message = { ...placeholder.message, swipes: placeholder.message.swipes ? [...placeholder.message.swipes] : undefined }
    if (!stepSwipe(message, step)) return false
    setRerollPlaceholder({ ...placeholder, message })
    return true
}

/**
 * Whether the old reply still stands in for the new one: held, nothing at its
 * place yet, or only the empty start a stream puts there before its first text.
 */
export function rerollPlaceholderShows(
    messages: readonly (SwipeMessage | null | undefined)[],
    placeholder: Pick<RerollPlaceholder, 'index' | 'hold'> | null | undefined,
): boolean {
    if (!placeholder) return false
    if (placeholder.hold || placeholder.index >= messages.length) return true
    const at = messages[placeholder.index]
    return !!at && at.role === 'char' && !at.data
}
