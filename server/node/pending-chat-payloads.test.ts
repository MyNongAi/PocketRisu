import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createPendingChatPayloads } = require('./pending-chat-payloads.cjs')

function fixture() {
    const kv = new Map<string, Buffer>()
    const journal = createPendingChatPayloads({
        kvGet: (key: string) => kv.get(key) ?? null,
        kvSet: (key: string, value: Buffer) => { kv.set(key, value) },
        kvDel: (key: string) => { kv.delete(key) },
        kvList: (prefix: string) => [...kv.keys()].filter(key => key.startsWith(prefix)),
    })
    return { kv, journal }
}

const chat = (messages: string[]) => ({
    id: 'chat-1',
    message: messages.map(data => ({ role: 'char', data })),
})

describe('durable pending chat bodies', () => {
    it('restores the latest acknowledged body over an older database copy', () => {
        const { journal } = fixture()
        journal.stage('char-1', 'chat-1', chat(['old']))
        journal.stage('char-1', 'chat-1', chat(['old', 'new']))
        const store = new Map([['char-1', new Map([['chat-1', chat(['old'])]])]])

        journal.restoreInto(store)

        expect(store.get('char-1')?.get('chat-1').message).toEqual(chat(['old', 'new']).message)
    })

    it('does not retire a newer journal entry after a stale database write', () => {
        const { journal } = fixture()
        journal.stage('char-1', 'chat-1', chat(['old', 'new']))

        journal.retireCommitted({ characters: [{ chaId: 'char-1', chats: [chat(['old'])] }] })
        expect(journal.has('char-1', 'chat-1')).toBe(true)

        journal.retireCommitted({ characters: [{ chaId: 'char-1', chats: [chat(['old', 'new'])] }] })
        expect(journal.has('char-1', 'chat-1')).toBe(false)
    })

    it('retains an orphaned new chat until its catalog entry is durable', () => {
        const { journal } = fixture()
        journal.stage('char-1', 'chat-1', chat(['new']))

        journal.retireCommitted({ characters: [{ chaId: 'char-1', chats: [] }] })
        expect(journal.has('char-1', 'chat-1')).toBe(true)

        const store = new Map()
        journal.restoreInto(store)
        expect(store.get('char-1')?.get('chat-1').message).toEqual(chat(['new']).message)
    })
})
