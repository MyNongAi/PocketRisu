import { describe, expect, it } from 'vitest'
import { clearSendEcho, setSendEcho } from './sendEcho'

describe('SEND-ECHO pending send bookkeeping', () => {
    it('keeps echoes in their own chats without changing the previous state', () => {
        const first = setSendEcho(new Map(), 'chat-a', { sendId: 'send-1', text: 'Hello' })
        const second = setSendEcho(first, 'chat-b', { sendId: 'send-2', text: 'World' })
        expect(first.has('chat-b')).toBe(false)
        expect(second.get('chat-a')?.text).toBe('Hello')
        expect(second.get('chat-b')?.text).toBe('World')
        expect(clearSendEcho(second, 'chat-a', 'send-1').has('chat-b')).toBe(true)
    })

    it('does not let an older send clear a newer echo for the same chat', () => {
        const first = setSendEcho(new Map(), 'chat-a', { sendId: 'send-1', text: 'First' })
        const second = setSendEcho(first, 'chat-a', { sendId: 'send-2', text: 'Second' })
        expect(clearSendEcho(second, 'chat-a', 'send-1')).toBe(second)
        expect(clearSendEcho(second, 'chat-a', 'send-2').has('chat-a')).toBe(false)
    })
})
