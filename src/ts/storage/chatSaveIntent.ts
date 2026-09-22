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

/**
 * Narrow a character's confirmed-chat set to the chats that still exist
 * locally, after a catalog save.
 *
 * Deliberately only removes. A catalog save writes metadata, so it proves
 * nothing about chat bodies; adding the local ids here would mark a chat whose
 * body never reached the server as confirmed, and its next save would be an
 * 'update' whose baseline probe 404s. Confirmation belongs to the body write.
 */
export function retainConfirmedChats(
    confirmedChatIds: ReadonlySet<string> | undefined,
    localChatIds: Iterable<string>,
): Set<string> {
    const local = localChatIds instanceof Set ? localChatIds : new Set(localChatIds)
    const retained = new Set<string>()
    for (const chatId of confirmedChatIds ?? []) {
        if (local.has(chatId)) retained.add(chatId)
    }
    return retained
}
