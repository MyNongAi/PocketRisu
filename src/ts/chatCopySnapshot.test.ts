import { describe, expect, it } from 'vitest'
import { chatForSave, messagesWithoutPendingReply } from './chatCopySnapshot'

const m = (chatId: string, data = chatId) => ({ chatId, data })

describe('chat copy while answering', () => {
    it('leaves out the reply being written and keeps the input that asked for it', () => {
        const messages = [m('a'), m('out1'), m('input2'), m('gen-1', 'partial…')]
        expect(messagesWithoutPendingReply(messages, 'gen-1').map((x) => x.chatId)).toEqual(['a', 'out1', 'input2'])
    })

    it('puts a reroll\'s old reply back in its place', () => {
        const old = { chatId: 'out1', data: 'old reply', swipes: ['x', 'old reply'] }
        const messages = [m('a'), m('input1'), m('gen-2', 'new…')]
        const copy = messagesWithoutPendingReply(messages, 'gen-2', { index: 2, message: old })
        expect(copy.map((x) => x.chatId)).toEqual(['a', 'input1', 'out1'])
        expect(copy[2]).toBe(old)
    })

    it('copies as it is when nothing is being written', () => {
        const messages = [m('a'), m('b')]
        expect(messagesWithoutPendingReply(messages, null)).toEqual(messages)
        // The old reply already in the chat is not added twice.
        expect(messagesWithoutPendingReply(messages, null, { index: 1, message: m('b') }).map((x) => x.chatId)).toEqual(['a', 'b'])
    })
})

describe('a chat saved while a reply is rerolled', () => {
    type Msg = { chatId: string, data: string, swipes?: string[], isComment?: boolean }
    const old: Msg = { chatId: 'out1', data: 'old reply', swipes: ['x', 'old reply'] }
    const comment: Msg = { chatId: 'note', data: 'branch note', isComment: true }

    it('keeps the old reply and the comments after it, without the reply being written', () => {
        const chat: { id: string, message: Msg[] } = { id: 'c', message: [m('a'), m('input1'), m('gen-2', 'new…')] }
        const saved = chatForSave(chat, 'gen-2', { index: 2, message: old, trailing: [comment] })
        expect(saved.message.map((x) => x.chatId)).toEqual(['a', 'input1', 'out1', 'note'])
        expect(saved.id).toBe('c')
        // the live chat is not touched
        expect(chat.message.map((x) => x.chatId)).toEqual(['a', 'input1', 'gen-2'])
    })

    it('is the chat itself when nothing is rerolled, and adds nothing twice', () => {
        const chat: { message: Msg[] } = { message: [m('a'), m('out1'), m('note')] }
        expect(chatForSave(chat, undefined, null)).toBe(chat)
        expect(chatForSave(chat, undefined, { index: 1, message: old, trailing: [comment] }).message.map((x) => x.chatId)).toEqual(['a', 'out1', 'note'])
    })
})
