// The bot list's borders (the user's request, 2026-10-25): yellow round the
// bot on screen, green round a bot holding a chat whose reply came in and has
// not been looked at yet (the chat list's ✅, chatReplyStatus.ts). The bot on
// screen stays yellow; its chats show their own checks.

import { fromStore } from 'svelte/store'
import { DBState, selectedCharID } from '../stores.svelte'
import { finishedReplies } from './chatReplyStatus'

export type CharacterRing = 'current' | 'replied'

interface ChatHolder {
    chaId?: string
    chats?: readonly ({ id?: string } | null | undefined)[]
}

/** The bots holding one of these chats, by chaId. */
export function charactersHoldingChats(chatIds: ReadonlySet<string>, characters: readonly (ChatHolder | null | undefined)[]): Set<string> {
    const holders = new Set<string>()
    // No check anywhere (the usual case): the bots' chats are not read at all.
    if (chatIds.size === 0) return holders
    for (const character of characters) {
        if (!character?.chaId || !Array.isArray(character.chats)) continue
        if (character.chats.some((chat) => !!chat?.id && chatIds.has(chat.id))) holders.add(character.chaId)
    }
    return holders
}

class CharacterRings {
    #marks = fromStore(finishedReplies)
    #selected = fromStore(selectedCharID)
    current = $derived(this.#selected.current >= 0 ? DBState.db?.characters?.[this.#selected.current]?.chaId ?? null : null)
    replied = $derived(charactersHoldingChats(this.#marks.current, DBState.db?.characters ?? []))

    of(chaId: string | undefined): CharacterRing | null {
        if (!chaId) return null
        if (chaId === this.current) return 'current'
        return this.replied.has(chaId) ? 'replied' : null
    }
}

export const characterRings = new CharacterRings()
