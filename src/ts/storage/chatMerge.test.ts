import { describe, expect, test } from 'vitest'
import { mergeChatMessages, messageBase } from './chatMerge'

type M = { role: string, data: string, chatId?: string, time?: number, swipes?: string[] }
const msg = (chatId: string, data: string, extra: Partial<M> = {}): M => ({ role: 'char', data, chatId, ...extra })
const ids = (messages: M[] | null) => messages?.map((m) => `${m.chatId}:${m.data}`) ?? null

describe('merging a chat by message id', () => {
    const a = msg('a', 'hello', { role: 'user' })
    const b = msg('b', 'hi there')
    const base = messageBase([a, b])!

    test("takes the other device's new messages when this one changed nothing", () => {
        const server = [a, b, msg('c', 'more', { role: 'user' }), msg('d', 'reply')]
        expect(ids(mergeChatMessages(base, [a, b], server))).toEqual(['a:hello', 'b:hi there', 'c:more', 'd:reply'])
    })

    test("keeps this device's new messages over an unchanged server copy", () => {
        const local = [a, b, msg('e', 'mine', { role: 'user' })]
        expect(ids(mergeChatMessages(base, local, [a, b]))).toEqual(['a:hello', 'b:hi there', 'e:mine'])
    })

    test('takes each side\'s edit, and an edit over a delete is no merge', () => {
        const editedHere = msg('a', 'hello!', { role: 'user' })
        const swipedThere = msg('b', 'hi there', { swipes: ['hi there', 'hey'] })
        expect(ids(mergeChatMessages(base, [editedHere, b], [a, swipedThere]))).toEqual(['a:hello!', 'b:hi there'])
        expect(mergeChatMessages(base, [editedHere, b], [a, swipedThere])![1]).toBe(swipedThere)
        // both sides changed the same message differently
        expect(mergeChatMessages(base, [a, msg('b', 'mine')], [a, msg('b', 'theirs')])).toBeNull()
        // deleted there, edited here
        expect(mergeChatMessages(base, [a, msg('b', 'edited')], [a])).toBeNull()
    })

    test('a delete on one side goes through when the other side left the message alone', () => {
        expect(ids(mergeChatMessages(base, [a], [a, b]))).toEqual(['a:hello'])
        expect(ids(mergeChatMessages(base, [a, b, msg('e', 'mine')], [b]))).toEqual(['b:hi there', 'e:mine'])
    })

    test('both sides wrote on from the same message: theirs first, then in time order', () => {
        const theirs = [a, b, msg('c', 'theirs', { time: 10 }), msg('d', 'theirs too', { time: 30 })]
        const mine = [a, b, msg('e', 'mine', { time: 20 })]
        expect(ids(mergeChatMessages(base, mine, theirs))).toEqual(['a:hello', 'b:hi there', 'c:theirs', 'e:mine', 'd:theirs too'])
    })

    test('an addition in the middle stays after the message it followed', () => {
        const local = [a, msg('x', 'inserted'), b]
        const server = [a, b, msg('c', 'theirs')]
        expect(ids(mergeChatMessages(base, local, server))).toEqual(['a:hello', 'x:inserted', 'b:hi there', 'c:theirs'])
    })

    test('messages without unique ids are not merged', () => {
        expect(messageBase([a, msg('', 'no id')])).toBeNull()
        expect(messageBase([a, a])).toBeNull()
        expect(mergeChatMessages(base, [a, b, { role: 'user', data: 'legacy' }], [a, b])).toBeNull()
    })
})
