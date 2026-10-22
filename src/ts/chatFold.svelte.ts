// The folded view of a chat: a "branched from" note shows the chat up to the
// message it branched at (foldChatToMessage, globalApi.svelte.ts), until the
// selection leaves that chat. Upstream's two effects read the fold right after
// dropping it, and the selected chat without a guard, so they threw whenever
// the selection moved to another bot or to nothing (a split pane touch); the
// throw aborted the flush and effects queued after it stopped for good
// (2026-10-22 split review).

export type ChatFoldTarget = {
    targetCharacterId: string
    targetChatId: string
    targetMessageId: string
}

type FoldChat = { id?: string, message?: Array<{ chatId?: string } | null | undefined> }
type FoldCharacter = { chaId?: string, chatPage?: number, chats?: Array<FoldChat | null | undefined> }

/** The selected chat when it is the one `fold` was made for, or null. */
export function foldedChatOf(fold: ChatFoldTarget | null, character: FoldCharacter | null | undefined): FoldChat | null {
    if (!fold || !character) return null
    const chat = character.chats?.[character.chatPage ?? 0]
    if (!chat || fold.targetCharacterId !== character.chaId || fold.targetChatId !== chat.id) return null
    return chat
}

/**
 * Inside an effect root: drops the fold once the selected chat is another
 * one, and keeps `index` at the folded message (-1 without one). Neither
 * effect throws on a missing character, chat or message.
 */
export function followChatFold(
    fold: { data: ChatFoldTarget | null },
    index: { index: number },
    selectedCharacter: () => FoldCharacter | null | undefined,
): void {
    $effect(() => {
        const data = fold.data
        if (data && !foldedChatOf(data, selectedCharacter())) fold.data = null
    })
    $effect(() => {
        // Without a fold, nothing else is read (the database may not be set yet).
        const data = fold.data
        const chat = data ? foldedChatOf(data, selectedCharacter()) : null
        if (!data || !chat) {
            index.index = -1
            return
        }
        const messageIndex = (chat.message ?? []).findIndex((message) => message?.chatId === data.targetMessageId)
        if (messageIndex === -1) console.warn('Target message for folding id' + data.targetMessageId + ' not found')
        index.index = messageIndex
    })
}

/** Where a folded chat's view starts, when the fold is for `chatId` and still inside its messages; -1 otherwise. */
export function foldStartFor(foldIndex: number, fold: ChatFoldTarget | null, chatId: string | undefined, messageCount: number): number {
    if (foldIndex < 0 || foldIndex >= messageCount || !fold || fold.targetChatId !== chatId) return -1
    return foldIndex
}
