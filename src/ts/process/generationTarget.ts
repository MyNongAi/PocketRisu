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
 * Puts `next` in the chat slot and returns what the slot now holds. In the
 * live database that is a reactive proxy over `next`, not `next` itself, and
 * a write to `next` is lost once the proxy has read that field (a save reads
 * every field): the long-term memory summaries of each send were written to
 * `next` after the start trigger swapped the chat, and none was ever kept
 * (2026-10-29: every send summarized the same messages again).
 */
export function placeChat(chats: Chat[], index: number, next: Chat): Chat {
    chats[index] = next
    return chats[index]
}

/**
 * Puts `next` (a trigger's resulting chat) in place of the chat `identity`
 * names, wherever that chat is now. Null, writing nothing, when it is gone or
 * only a placeholder: a button's result was written into whichever chat was
 * selected when its trigger ended (the split's other pane, 2026-10-22).
 */
export function writeBackToTarget(
    characters: readonly character[],
    identity: GenerationTargetIdentity,
    next: Chat,
    normalize: (chat: Chat) => Chat = (chat) => chat,
): ResolvedGenerationTarget | null {
    // Only that chat's own result: another chat's object here would take its place.
    if (identity.chatId ? next?.id !== identity.chatId : next !== identity.chatRef && next?.id) return null
    const target = resolveGenerationTarget(characters, identity)
    if (!target || target.chat._placeholder) return null
    target.character.chats[target.chatIndex] = normalize(next)
    return { ...target, chat: target.character.chats[target.chatIndex] }
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
