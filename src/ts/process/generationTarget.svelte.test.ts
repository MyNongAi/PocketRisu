import { describe, expect, test } from 'vitest'
import type { Chat } from '../storage/database.svelte'
import { placeChat } from './generationTarget'

// A trigger's resulting chat swapped into the live (reactive) database: the
// send keeps writing to it afterwards, the memory summaries above all.
describe('placeChat', () => {
    function liveChats() {
        const db = $state({ chats: [{ id: 'chat-1', message: [], hypaV3Data: { summaries: [] } } as unknown as Chat] })
        return db
    }

    test('a write after a save has read the chat reaches the database', () => {
        const db = liveChats()
        const fromTrigger = { id: 'chat-1', message: [], hypaV3Data: { summaries: [] } } as unknown as Chat
        const placed = placeChat(db.chats, 0, fromTrigger)
        // A save reads every field of the chat it uploads.
        void $state.snapshot(db.chats[0])

        placed.hypaV3Data = { summaries: [{ text: 'summary', chatMemos: ['m1'] }] } as unknown as Chat['hypaV3Data']

        expect($state.snapshot(db.chats[0]).hypaV3Data?.summaries).toHaveLength(1)
    })

    test('the object handed in is not what the database holds', () => {
        const db = liveChats()
        const fromTrigger = { id: 'chat-1', message: [], hypaV3Data: { summaries: [] } } as unknown as Chat
        placeChat(db.chats, 0, fromTrigger)
        void $state.snapshot(db.chats[0])

        // What the send did before: the summaries never reached the database.
        fromTrigger.hypaV3Data = { summaries: [{ text: 'summary', chatMemos: ['m1'] }] } as unknown as Chat['hypaV3Data']

        expect($state.snapshot(db.chats[0]).hypaV3Data?.summaries).toHaveLength(0)
    })
})
