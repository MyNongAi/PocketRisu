// A chat copied while it is answering (the user's request, 2026-10-17): the
// copy is taken at once and holds everything up to the last finished output,
// without the reply being written. A reroll's old reply, which stays on screen
// until the new one shows text (rerollPlaceholder.ts) but is out of the chat
// meanwhile, goes back in its place. (Before, the copy waited for the reply
// and then held the new one.)
//
// The chat saved while a reply is rerolled is built the same way (the user's
// request, 2026-10-19): the old reply and the comments after it, which the
// reroll took out, are saved in place, so closing the app mid-reroll loses
// none of its pages.

type CopyMessage = { chatId?: string }

export type RerollRestore<M> = {
    index: number
    message: M
    /** Comments and disabled messages after the old reply, out with it. */
    trailing?: readonly M[]
}

export function messagesWithoutPendingReply<M extends CopyMessage>(
    messages: readonly M[],
    pendingGenerationId: string | null | undefined,
    placeholder?: RerollRestore<M> | null,
): M[] {
    // The reply being written carries its generation's id (sendChat).
    const kept = pendingGenerationId ? messages.filter((message) => message.chatId !== pendingGenerationId) : [...messages]
    if (placeholder && placeholder.index >= 0 && placeholder.index <= kept.length) {
        const present = (message: M) => !!message.chatId && kept.some((other) => other.chatId === message.chatId)
        if (present(placeholder.message)) return kept
        const restored = [placeholder.message, ...(placeholder.trailing ?? []).filter((message) => !present(message))]
        kept.splice(placeholder.index, 0, ...restored)
    }
    return kept
}

/** A chat as saved while a reply of it is rerolled (see above). */
export function chatForSave<C extends { message: M[] }, M extends CopyMessage>(
    chat: C,
    pendingGenerationId: string | null | undefined,
    placeholder: RerollRestore<M> | null | undefined,
): C {
    if (!placeholder) return chat
    return { ...chat, message: messagesWithoutPendingReply(chat.message, pendingGenerationId, placeholder) }
}
