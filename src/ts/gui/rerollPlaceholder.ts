// While a reply is rerolled, the old one stays on screen until the new one
// shows text (the user's request, 2026-10-09): pressing reroll used to blank
// the end of the chat for the whole wait. The chat itself already holds the
// messages without it (the prompt is built from them, unchanged); this only
// tells the chat list what to draw at its place meanwhile, and lets its swipes
// be browsed. Once the new reply has text, or the reroll ends either way, the
// copy goes.
import { get, writable } from 'svelte/store'
import { stepSwipe, type SwipeMessage } from '../chatSwipes'

export type RerollPlaceholder<M extends SwipeMessage = SwipeMessage> = {
    /** The chat being rerolled. */
    chatId: string
    /** Where the new reply goes: the old one's place. */
    index: number
    /** A copy of the old reply; browsing its swipes changes only the copy. */
    message: M
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

/** Show the copy's previous (-1) or next (+1) swipe. False when it has none. */
export function stepRerollPlaceholderSwipe(chatId: string, step: -1 | 1): boolean {
    const placeholder = get(rerollPlaceholders).get(chatId)
    if (!placeholder) return false
    const message = { ...placeholder.message, swipes: placeholder.message.swipes ? [...placeholder.message.swipes] : undefined }
    if (!stepSwipe(message, step)) return false
    setRerollPlaceholder({ ...placeholder, message })
    return true
}

/**
 * Whether the old reply still stands in for the new one: nothing at its place
 * yet, or only the empty start a stream puts there before its first text.
 */
export function rerollPlaceholderShows(
    messages: readonly (SwipeMessage | null | undefined)[],
    placeholder: Pick<RerollPlaceholder, 'index'> | null | undefined,
): boolean {
    if (!placeholder) return false
    if (placeholder.index >= messages.length) return true
    const at = messages[placeholder.index]
    return !!at && at.role === 'char' && !at.data
}
