import type { Chat, character } from '../storage/database.svelte'
import { v4 } from 'uuid'

export interface GenerationTargetIdentity {
    characterRef: character
    chatRef: Chat
    characterId?: string
    chatId?: string
}

export interface ResolvedGenerationTarget {
    character: character
    chat: Chat
    characterIndex: number
    chatIndex: number
}

export function captureGenerationTarget(character: character, chat: Chat): GenerationTargetIdentity {
    // Old imports can lack Chat.id. Assign it synchronously at the capture
    // boundary so two legacy chats never share the `nochat` generation key,
    // and so a later trigger-produced object replacement remains resolvable.
    chat.id ||= v4()
    return {
        characterRef: character,
        chatRef: chat,
        characterId: character.chaId,
        chatId: chat.id,
    }
}

function uniqueIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
    let found = -1
    for (let index = 0; index < items.length; index += 1) {
        if (!predicate(items[index])) continue
        if (found !== -1) return -1
        found = index
    }
    return found
}

/**
 * Re-find an in-flight request target after UI selection, sorting, or object
 * replacement. Ambiguous/missing identities deliberately fail closed so a
 * response can never be written into whichever chat happens to be selected.
 */
export function resolveGenerationTarget(
    characters: readonly character[],
    identity: GenerationTargetIdentity,
): ResolvedGenerationTarget | null {
    let characterIndex = characters.indexOf(identity.characterRef)
    if (characterIndex < 0 && identity.characterId) {
        characterIndex = uniqueIndex(characters, (candidate) => candidate.chaId === identity.characterId)
    }
    if (characterIndex < 0) return null

    const character = characters[characterIndex]
    if (identity.characterId && character.chaId !== identity.characterId) return null

    let chatIndex = character.chats.indexOf(identity.chatRef)
    if (chatIndex < 0 && identity.chatId) {
        chatIndex = uniqueIndex(character.chats, (candidate) => candidate.id === identity.chatId)
    }
    if (chatIndex < 0) return null

    const chat = character.chats[chatIndex]
    if (identity.chatId && chat.id !== identity.chatId) return null
    return { character, chat, characterIndex, chatIndex }
}
