import { describe, expect, test } from 'vitest'
import { chatHoldsAllMessages } from './chatConflict'

const msg = (role: string, data: string, chatId?: string) => ({ role, data, chatId })

describe('chatHoldsAllMessages', () => {
    test('a local chat that extends the server copy holds it all', () => {
        const server = { message: [msg('user', 'a', '1'), msg('char', 'b', '2')] }
        const local = { message: [...server.message, msg('user', 'c', '3'), msg('char', 'd', '4')] }
        expect(chatHoldsAllMessages(local, server)).toBe(true)
    })

    test('identical chats and an empty server copy are held', () => {
        const chat = { message: [msg('user', 'a', '1')] }
        expect(chatHoldsAllMessages(chat, chat)).toBe(true)
        expect(chatHoldsAllMessages(chat, { message: [] })).toBe(true)
        expect(chatHoldsAllMessages(chat, {})).toBe(true)
    })

    test('messages another device added are not held', () => {
        const local = { message: [msg('user', 'a', '1'), msg('user', 'mine', '5')] }
        const server = { message: [msg('user', 'a', '1'), msg('user', 'theirs', '6')] }
        expect(chatHoldsAllMessages(local, server)).toBe(false)
    })

    test('a message edited on another device is not held', () => {
        const local = { message: [msg('char', 'old text', '2')] }
        const server = { message: [msg('char', 'new text', '2')] }
        expect(chatHoldsAllMessages(local, server)).toBe(false)
    })

    test('a server message this device deleted is not held', () => {
        const local = { message: [msg('user', 'a', '1')] }
        const server = { message: [msg('user', 'a', '1'), msg('char', 'b', '2')] }
        expect(chatHoldsAllMessages(local, server)).toBe(false)
    })

    test('order matters', () => {
        const local = { message: [msg('char', 'b', '2'), msg('user', 'a', '1')] }
        const server = { message: [msg('user', 'a', '1'), msg('char', 'b', '2')] }
        expect(chatHoldsAllMessages(local, server)).toBe(false)
    })

    test('messages without ids match on role and text', () => {
        const local = { message: [msg('user', 'a'), msg('char', 'b')] }
        const server = { message: [msg('user', 'a')] }
        expect(chatHoldsAllMessages(local, server)).toBe(true)
    })

    test('the same id with a different role is not the same message', () => {
        expect(chatHoldsAllMessages({ message: [msg('char', 'a', '1')] }, { message: [msg('user', 'a', '1')] })).toBe(false)
    })
})
