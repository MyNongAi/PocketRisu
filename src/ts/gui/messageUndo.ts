// Messages deleted a moment ago can be put back (the user's request,
// 2026-11-08: "방금 메시지 삭제한거만 일시적 복구할수있는 기능"). Each deletion
// from a message's trash button is kept in memory, per chat, until the app is
// reloaded: the newest few per chat, and only so many in all. The toast that
// says a message was deleted has "되돌리기" for that deletion, and the
// composer's ☰ menu puts back the chat's newest one (again for the one
// before). Nothing is written anywhere: once the app reloads they are gone,
// like any undo.
//
// A deletion goes back where it was: right after the message that was before
// it, found by its id, so messages sent since stay after it. A message already
// back in the chat is not added twice.
import { writable } from 'svelte/store'

type UndoMessage = { chatId?: string }

export type MessageDeletion<M extends UndoMessage = UndoMessage> = {
    id: number
    /** chaId of the bot and id of the chat the messages were in. */
    chaId: string
    chatId: string
    /** Detached copies of the deleted messages, in order. */
    messages: M[]
    /** Where the first of them was. */
    index: number
    /** chatId of the message right before them; null when they began the chat. */
    after: string | null
}

export const MESSAGE_UNDO_PER_CHAT = 5
export const MESSAGE_UNDO_TOTAL = 30

let nextId = 1

/** All kept deletions, oldest first. A store so the ☰ menu follows it. */
export const messageDeletions = writable<MessageDeletion[]>([])

/** Keep a deletion; returns its id (for the toast's undo). */
export function recordMessageDeletion<M extends UndoMessage>(deletion: Omit<MessageDeletion<M>, 'id'>): number {
    const id = nextId++
    messageDeletions.update((list) => {
        const next = [...list, { ...deletion, id } as MessageDeletion]
        // The newest few per chat, and so many in all.
        const sameChat = next.filter((entry) => entry.chaId === deletion.chaId && entry.chatId === deletion.chatId)
        const dropped = new Set(sameChat.slice(0, Math.max(0, sameChat.length - MESSAGE_UNDO_PER_CHAT)).map((entry) => entry.id))
        const kept = next.filter((entry) => !dropped.has(entry.id))
        return kept.slice(Math.max(0, kept.length - MESSAGE_UNDO_TOTAL))
    })
    return id
}

/** The chat's newest kept deletion. */
export function lastMessageDeletion(list: readonly MessageDeletion[], chaId: string, chatId: string): MessageDeletion | undefined {
    return list.findLast((entry) => entry.chaId === chaId && entry.chatId === chatId)
}

/** `messages` with a deletion put back (a new array); `restored` counts what went back. */
export function withDeletionRestored<M extends UndoMessage>(messages: readonly M[], deletion: MessageDeletion<M>): { messages: M[], restored: number } {
    const present = new Set(messages.map((message) => message.chatId).filter(Boolean))
    const back = deletion.messages.filter((message) => !message.chatId || !present.has(message.chatId))
    if (back.length === 0) return { messages: [...messages], restored: 0 }
    let at: number
    if (deletion.after === null) at = 0
    else {
        const anchor = messages.findIndex((message) => message.chatId === deletion.after)
        at = anchor >= 0 ? anchor + 1 : Math.min(deletion.index, messages.length)
    }
    const next = [...messages]
    next.splice(at, 0, ...structuredClone(back))
    return { messages: next, restored: back.length }
}

/** Take a deletion out of the kept list (it was put back, or cannot be). */
export function forgetMessageDeletion(id: number): void {
    messageDeletions.update((list) => list.filter((entry) => entry.id !== id))
}
