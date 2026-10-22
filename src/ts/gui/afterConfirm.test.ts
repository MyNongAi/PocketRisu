import { describe, expect, it } from 'vitest'
import { chatIndexAfterConfirm, messageIndexAfterConfirm } from './afterConfirm'

const message = (chatId: string) => ({ chatId, role: 'user', data: chatId })

describe('messageIndexAfterConfirm', () => {
    const owner = () => ({ id: 'c', message: [message('m0'), message('m1'), message('m2')] })

    it('is the same index when nothing changed', () => {
        const chat = owner()
        expect(messageIndexAfterConfirm(chat, chat, chat.message[1])).toBe(1)
    })
    it('follows the message after an earlier one was deleted', () => {
        const chat = owner()
        const target = chat.message[2]
        chat.message.splice(0, 1)
        expect(messageIndexAfterConfirm(chat, chat, target)).toBe(1)
    })
    it('is -1 when the pane now shows another chat', () => {
        const chat = owner()
        const other = { id: 'other', message: [message('m0'), message('m1')] }
        expect(messageIndexAfterConfirm(other, chat, chat.message[1])).toBe(-1)
    })
    it('is -1 when the message is gone', () => {
        const chat = owner()
        const target = chat.message[1]
        chat.message.splice(1, 1)
        expect(messageIndexAfterConfirm(chat, chat, target)).toBe(-1)
    })
    it('finds a message without an id by object', () => {
        const target: { chatId?: string, role: string, data: string } = { role: 'char', data: 'x' }
        const chat = { message: [message('m0'), target] }
        expect(messageIndexAfterConfirm(chat, chat, target)).toBe(1)
    })
})

describe('chatIndexAfterConfirm', () => {
    it('finds the clicked chat after the list moved', () => {
        const b = { id: 'b' }
        const chats = [{ id: 'new' }, { id: 'a' }, b]
        expect(chatIndexAfterConfirm(chats, b)).toBe(2)
    })
    it('finds a replaced chat by its id', () => {
        expect(chatIndexAfterConfirm([{ id: 'a' }, { id: 'b' }], { id: 'b' })).toBe(1)
    })
    it('is -1 when the chat is gone', () => {
        expect(chatIndexAfterConfirm([{ id: 'a' }], { id: 'b' })).toBe(-1)
    })
})
