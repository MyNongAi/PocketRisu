import { describe, expect, it, vi } from 'vitest'
import type { character } from '../storage/database.svelte'
import { ChatSearchSource, type PeekChat, type SearchSnapshot } from './chatSearchSource'

// The source reads placeholders through the injected peek; the real storage is never loaded here.
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: {} } }))

const chat = (id: string, data: string, placeholder = false) => ({
    id, name: id, message: placeholder ? [] : [{ role: 'user' as const, data, chatId: `${id}-m` }],
    _placeholder: placeholder,
})
const characterWith = (...chats: ReturnType<typeof chat>[]) => ({ chaId: 'bot', chats }) as unknown as character
async function settled(source: ChatSearchSource, query: string): Promise<SearchSnapshot> {
    return new Promise(resolve => source.search(query, snapshot => { if (!snapshot.reading) resolve(snapshot) }))
}

describe('CHAT-SEARCH read-only source', () => {
    it('searches memory live and reads a placeholder once across queries', async () => {
        const memory = chat('a', 'old')
        const peek = vi.fn<PeekChat>(async () => ({ message: [{ role: 'char', data: 'needle', chatId: 'b-m' }] }))
        const source = new ChatSearchSource(characterWith(memory, chat('b', '', true)), peek)
        expect((await settled(source, 'needle')).count).toBe(1)
        memory.message[0].data = 'needle now'
        expect((await settled(source, 'needle')).count).toBe(2)
        expect(peek).toHaveBeenCalledTimes(1)
        source.dispose()
    })
    it('aborts pending reads and stops the queue', async () => {
        const peek = vi.fn<PeekChat>((_bot, _index, _id, signal) => new Promise(resolve => {
            signal.addEventListener('abort', () => resolve(null), { once: true })
        }))
        const source = new ChatSearchSource(characterWith(chat('a', '', true), chat('b', '', true), chat('c', '', true)), peek)
        source.search('x', () => {})
        source.dispose()
        await Promise.resolve()
        expect(peek).toHaveBeenCalledTimes(2)
    })
    it('counts failed reads without looping', async () => {
        const peek = vi.fn<PeekChat>(async () => { throw new Error('offline') })
        const source = new ChatSearchSource(characterWith(chat('a', '', true)), peek)
        expect((await settled(source, 'x')).failed).toBe(1)
        expect((await settled(source, 'y')).failed).toBe(1)
        expect(peek).toHaveBeenCalledTimes(1)
        source.dispose()
    })
    it('evicts the oldest body past the character cap and reads it again', async () => {
        const peek = vi.fn<PeekChat>(async (_bot, _index, id) => ({ message: [{ role: 'char', data: id.repeat(3) }] }))
        const source = new ChatSearchSource(characterWith(chat('a', '', true), chat('b', '', true)), peek, 3)
        await settled(source, 'a')
        await settled(source, 'a')
        expect(peek.mock.calls.filter(call => call[2] === 'a')).toHaveLength(2)
        source.dispose()
    })
})
