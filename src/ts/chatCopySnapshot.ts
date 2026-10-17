// A chat copied while it is answering (the user's request, 2026-10-17): the
// copy is taken at once and holds everything up to the last finished output,
// without the reply being written. A reroll's old reply, which stays on screen
// until the new one shows text (rerollPlaceholder.ts) but is out of the chat
// meanwhile, goes back in its place. (Before, the copy waited for the reply
// and then held the new one.)

type CopyMessage = { chatId?: string }

export function messagesWithoutPendingReply<M extends CopyMessage>(
    messages: readonly M[],
    pendingGenerationId: string | null | undefined,
    placeholder?: { index: number, message: M } | null,
): M[] {
    // The reply being written carries its generation's id (sendChat).
    const kept = pendingGenerationId ? messages.filter((message) => message.chatId !== pendingGenerationId) : [...messages]
    if (placeholder && placeholder.index >= 0 && placeholder.index <= kept.length) {
        const id = placeholder.message.chatId
        if (!id || !kept.some((message) => message.chatId === id)) kept.splice(placeholder.index, 0, placeholder.message)
    }
    return kept
}
