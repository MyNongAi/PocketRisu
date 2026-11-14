import { describe, expect, it } from 'vitest'
import { closeMessageEdit, messageEditIndex, openMessageEdit, readMessageEdit, updateMessageEdit, type MessageEditIdentity } from './openMessageEdits'

const message = (overrides: Partial<MessageEditIdentity> = {}): MessageEditIdentity => ({
    chaId: 'character-a', chatId: 'chat-a', chatIndex: 0,
    messageKey: 'id:message-a', role: 'user', ...overrides,
})

describe('open original message edits', () => {
    it('restores the typed text after a remount despite a changed message field', () => {
        const identity = { ...message(), disabled: undefined }
        openMessageEdit(identity, 'sent')
        updateMessageEdit(identity, 'typed but unsaved')
        const remounted = { ...message(), disabled: false }
        expect(readMessageEdit(remounted)).toBe('typed but unsaved')
        closeMessageEdit(identity)
    })

    it('has nothing open for a message without an identity (the greeting)', () => {
        expect(readMessageEdit(null)).toBeUndefined()
        expect(readMessageEdit(undefined)).toBeUndefined()
    })

    it('keeps characters, chats, and messages separate', () => {
        const identity = message()
        openMessageEdit(identity, 'draft')
        expect(readMessageEdit(message({ chaId: 'character-b' }))).toBeUndefined()
        expect(readMessageEdit(message({ chatId: 'chat-b' }))).toBeUndefined()
        expect(readMessageEdit(message({ messageKey: 'id:message-b' }))).toBeUndefined()
        expect(readMessageEdit(message({ chatId: undefined, chatIndex: 1 }))).toBeUndefined()
        closeMessageEdit(identity)
    })

    it('uses the chat index only when its id is absent', () => {
        const identity = message({ chatId: undefined, chatIndex: 2, messageKey: 'index:3' })
        openMessageEdit(identity, 'draft')
        expect(readMessageEdit(message({ chatId: undefined, chatIndex: 2, messageKey: 'index:3' }))).toBe('draft')
        expect(readMessageEdit(message({ chatId: undefined, chatIndex: 3, messageKey: 'index:3' }))).toBeUndefined()
        closeMessageEdit(identity)
    })

    it.each(['save', 'cancel'])('does not reopen after %s', () => {
        const identity = message({ role: 'char' })
        openMessageEdit(identity, 'reply draft')
        closeMessageEdit(identity)
        updateMessageEdit(identity, 'late input')
        expect(readMessageEdit(identity)).toBeUndefined()
    })

    it('drops an index-only draft when another role takes the slot', () => {
        const identity = message({ messageKey: 'index:1' })
        openMessageEdit(identity, 'old draft')
        expect(readMessageEdit(message({ messageKey: 'index:1', role: 'char' }))).toBeUndefined()
        expect(readMessageEdit(identity)).toBeUndefined()
    })

    it('finds a moved id and refuses a reused index', () => {
        const identity = message()
        const messages = [{ role: 'char' }, { role: 'user', chatId: 'message-a' }]
        expect(messageEditIndex(messages, identity, 0)).toBe(1)
        expect(messageEditIndex(messages, message({ messageKey: 'index:0' }), 0)).toBe(-1)
        expect(messageEditIndex(messages, message({ messageKey: 'id:missing' }), 0)).toBe(-1)
    })
})
