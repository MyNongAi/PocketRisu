// Finding again, after a question the user can leave open (a tucked-away
// dialog, ALERT-QUESTION-TUCK), what was clicked before it. The list can
// change meanwhile (a new or deleted chat, a reply, the other split pane
// choosing another chat), so an index kept from the click named a neighbour:
// a delete removed the wrong message or chat (2026-10-22 split review).

type MessageLike = { chatId?: string }
type ChatLike = { id?: string, message?: MessageLike[] }

/**
 * Where `target`, a message of `ownerChat` when the click happened, is now in
 * `now` (the chat on screen); -1 when that is another chat or the message is
 * gone.
 */
export function messageIndexAfterConfirm(now: ChatLike | null | undefined, ownerChat: ChatLike, target: MessageLike): number {
    if (!now || (ownerChat.id ? now.id !== ownerChat.id : now !== ownerChat)) return -1
    const messages = now.message ?? []
    if (target.chatId) return messages.findIndex((message) => message?.chatId === target.chatId)
    return messages.indexOf(target)
}

/** Where `target` is now among `chats` (the same object, else its id); -1 when gone. */
export function chatIndexAfterConfirm(chats: readonly (ChatLike | null | undefined)[], target: ChatLike): number {
    const at = chats.indexOf(target)
    if (at >= 0) return at
    return target.id ? chats.findIndex((chat) => chat?.id === target.id) : -1
}
