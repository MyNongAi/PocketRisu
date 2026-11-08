import { beforeEach, describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import {
    forgetMessageDeletion, lastMessageDeletion, messageDeletions, recordMessageDeletion, withDeletionRestored,
    MESSAGE_UNDO_PER_CHAT, MESSAGE_UNDO_TOTAL,
} from './messageUndo'

const m = (chatId: string) => ({ chatId, data: chatId })
const ids = (list: { chatId?: string }[]) => list.map((x) => x.chatId)

beforeEach(() => messageDeletions.set([]))

describe('putting deleted messages back (2026-11-08)', () => {
    it('puts one message back after the message that was before it', () => {
        const deletion = { id: 1, chaId: 'b', chatId: 'c', messages: [m('x')], index: 1, after: 'a' }
        const { messages, restored } = withDeletionRestored([m('a'), m('b')], deletion)
        expect(ids(messages)).toEqual(['a', 'x', 'b'])
        expect(restored).toBe(1)
    })

    it('puts "this and after" back in order, before messages sent since', () => {
        const deletion = { id: 1, chaId: 'b', chatId: 'c', messages: [m('x'), m('y')], index: 2, after: 'b' }
        expect(ids(withDeletionRestored([m('a'), m('b'), m('new')], deletion).messages)).toEqual(['a', 'b', 'x', 'y', 'new'])
    })

    it('puts the first messages back at the top, and goes by place when the one before is gone', () => {
        expect(ids(withDeletionRestored([m('b')], { id: 1, chaId: 'b', chatId: 'c', messages: [m('a')], index: 0, after: null }).messages)).toEqual(['a', 'b'])
        expect(ids(withDeletionRestored([m('a'), m('c')], { id: 2, chaId: 'b', chatId: 'c', messages: [m('x')], index: 1, after: 'gone' }).messages)).toEqual(['a', 'x', 'c'])
        expect(ids(withDeletionRestored([m('a')], { id: 3, chaId: 'b', chatId: 'c', messages: [m('x')], index: 9, after: 'gone' }).messages)).toEqual(['a', 'x'])
    })

    it('does not add a message twice, and gives copies', () => {
        const kept = m('x')
        const deletion = { id: 1, chaId: 'b', chatId: 'c', messages: [kept, m('y')], index: 1, after: 'a' }
        const { messages, restored } = withDeletionRestored([m('a'), m('x')], deletion)
        expect(ids(messages)).toEqual(['a', 'y', 'x'])
        expect(restored).toBe(1)
        const again = withDeletionRestored([m('a')], deletion).messages
        expect(again[1]).not.toBe(kept)
    })

    it('keeps the newest few per chat and so many in all, and finds the chat\'s newest', () => {
        for (let i = 0; i < MESSAGE_UNDO_PER_CHAT + 2; i++) recordMessageDeletion({ chaId: 'b', chatId: 'c', messages: [m(`d${i}`)], index: 0, after: null })
        const sameChat = get(messageDeletions).filter((entry) => entry.chatId === 'c')
        expect(sameChat).toHaveLength(MESSAGE_UNDO_PER_CHAT)
        expect(ids(lastMessageDeletion(get(messageDeletions), 'b', 'c')!.messages)).toEqual([`d${MESSAGE_UNDO_PER_CHAT + 1}`])
        expect(lastMessageDeletion(get(messageDeletions), 'b', 'other')).toBeUndefined()
        for (let i = 0; i < MESSAGE_UNDO_TOTAL + 5; i++) recordMessageDeletion({ chaId: 'b', chatId: `c${i}`, messages: [m('z')], index: 0, after: null })
        expect(get(messageDeletions)).toHaveLength(MESSAGE_UNDO_TOTAL)
    })

    it('forgets one that was put back; the one before is next', () => {
        const first = recordMessageDeletion({ chaId: 'b', chatId: 'c', messages: [m('1')], index: 0, after: null })
        const second = recordMessageDeletion({ chaId: 'b', chatId: 'c', messages: [m('2')], index: 0, after: null })
        forgetMessageDeletion(second)
        expect(lastMessageDeletion(get(messageDeletions), 'b', 'c')?.id).toBe(first)
    })
})
