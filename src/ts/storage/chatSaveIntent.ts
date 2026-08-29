export type ChatSaveIntent = 'create' | 'update'

/**
 * A chat ID absent from the last server-confirmed catalog is a create. The
 * live character array cannot answer this safely because imports/new-chat UI
 * insert their local object before the payload reaches the server.
 */
export function classifyChatSaveIntent(
    knownChatsByCharacter: ReadonlyMap<string, ReadonlySet<string>> | undefined,
    chaId: string,
    chatId: string,
): ChatSaveIntent {
    // Missing baseline state fails closed: an existing remote chat must never
    // be recreated merely because the client forgot what it had loaded.
    if (!knownChatsByCharacter) return 'update'
    const knownChatIds = knownChatsByCharacter.get(chaId)
    if (!knownChatIds) return 'create'
    return knownChatIds.has(chatId) ? 'update' : 'create'
}
