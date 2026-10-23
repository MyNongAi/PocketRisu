import { describe, expect, test, vi } from 'vitest'
import { CACHE_MIN_MESSAGES, createChatDeltaSync, type ChatCopyStore, type ChatDeltaTransport } from './chatDeltaSync'
import { messageFingerprints, prefixFingerprint } from './chatFingerprint'

const msg = (i: number, data = `message ${i}`) => ({ role: (i % 2 ? 'char' : 'user') as 'char' | 'user', data, chatId: `m${i}`, time: i })
const chatOf = (n: number, extra: Record<string, unknown> = {}) => ({ id: 'chat', name: 'Chat', note: '', localLore: [], fmIndex: -1, message: Array.from({ length: n }, (_, i) => msg(i)), ...extra }) as any

// A fake server holding one chat that verifies prefixes exactly like server.cjs.
function fakeServer(initial: any) {
    let stored = structuredClone(initial)
    const matches = (base: { count: number, fp: string }) =>
        base.count <= stored.message.length && prefixFingerprint(messageFingerprints(stored.message.slice(0, base.count)), base.count) === base.fp
    const transport: ChatDeltaTransport = {
        fetchChatContentDelta: vi.fn(async (_a, _i, _c, base) => {
            if (base && matches(base)) return { chat: structuredClone({ ...stored, message: stored.message.slice(base.count) }), deltaBase: base.count }
            return { chat: structuredClone(stored), deltaBase: null }
        }),
        saveChatContentDelta: vi.fn(async (_a, _i, _c, chat, base) => {
            const body = structuredClone(chat)
            if (base) {
                if (!matches(base)) return 'base-mismatch' as const
                body.message = stored.message.slice(0, base.count).concat(body.message)
            }
            stored = body
            return 'ok' as const
        }),
    }
    return { transport, get stored() { return stored }, set stored(v) { stored = v } }
}

function memoryCopies(): ChatCopyStore & { map: Map<string, any> } {
    const map = new Map<string, any>()
    return { map, get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : null), put: async (k, c) => { map.set(k, structuredClone(c)) } }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('chat delta sync — loading', () => {
    test('first open fetches the whole chat and keeps a copy of long chats', async () => {
        const server = fakeServer(chatOf(CACHE_MIN_MESSAGES + 10))
        const copies = memoryCopies()
        const sync = createChatDeltaSync(server.transport, copies)
        const chat = await sync.fetchChat('char', 0, 'chat')
        expect(chat).toEqual(server.stored)
        expect((server.transport.fetchChatContentDelta as any).mock.calls[0][3]).toBeNull()
        await settle()
        expect(copies.map.get('char|chat')).toEqual(server.stored)
    })

    test('reopening with a copy receives only the new messages and assembles the full chat', async () => {
        const server = fakeServer(chatOf(60))
        const copies = memoryCopies()
        const sync = createChatDeltaSync(server.transport, copies)
        await sync.fetchChat('char', 0, 'chat'); await settle()
        server.stored = { ...server.stored, note: 'changed note', message: [...server.stored.message, msg(60), msg(61)] }
        const fetched = await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat')
        const lastCall = (server.transport.fetchChatContentDelta as any).mock.results.at(-1).value
        expect((await lastCall).deltaBase).toBe(60)
        expect((await lastCall).chat.message).toHaveLength(2)
        expect(fetched).toEqual(server.stored)
    })

    test('a copy that no longer matches (older message edited elsewhere) falls back to the whole chat', async () => {
        const server = fakeServer(chatOf(60))
        const copies = memoryCopies()
        await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat'); await settle()
        server.stored.message[3] = msg(3, 'edited on another device')
        const fetched = await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat')
        expect(fetched).toEqual(server.stored)
        expect(fetched!.message[3].data).toBe('edited on another device')
    })

    test('a broken local store never blocks loading', async () => {
        const server = fakeServer(chatOf(60))
        const broken: ChatCopyStore = { get: async () => { throw new Error('quota') }, put: async () => { throw new Error('quota') } }
        expect(await createChatDeltaSync(server.transport, broken).fetchChat('char', 0, 'chat')).toEqual(server.stored)
    })
})

describe('chat delta sync — saving', () => {
    async function opened(n = 60) {
        const server = fakeServer(chatOf(n))
        const sync = createChatDeltaSync(server.transport, memoryCopies())
        const chat = await sync.fetchChat('char', 0, 'chat')
        return { server, sync, chat: structuredClone(chat)! }
    }
    const lastSave = (server: ReturnType<typeof fakeServer>) => (server.transport.saveChatContentDelta as any).mock.calls.at(-1)

    test('appended messages go out alone and the server ends up with the whole chat', async () => {
        const { server, sync, chat } = await opened()
        chat.message.push(msg(60), msg(61))
        await sync.saveChat('char', 0, 'chat', chat)
        const [, , , body, base] = lastSave(server)
        expect(base.count).toBe(60)
        expect(body.message).toHaveLength(2)
        expect(server.stored).toEqual(chat)
    })

    test('a reroll (last message replaced) sends only from the changed message', async () => {
        const { server, sync, chat } = await opened()
        chat.message[59] = msg(59, 'rerolled answer')
        await sync.saveChat('char', 0, 'chat', chat)
        const [, , , body, base] = lastSave(server)
        expect(base.count).toBe(59)
        expect(body.message.map((m: any) => m.data)).toEqual(['rerolled answer'])
        expect(server.stored).toEqual(chat)
    })

    test('deleting and editing older messages still leaves the server identical to the client', async () => {
        const { server, sync, chat } = await opened()
        chat.message.splice(10, 5)
        chat.message[2] = msg(2, 'edited early message')
        chat.scriptstate = { hp: 3 }
        await sync.saveChat('char', 0, 'chat', chat)
        expect(lastSave(server)[4].count).toBe(2)
        expect(server.stored).toEqual(chat)
    })

    test('a server that changed underneath (another device) gets a full save instead', async () => {
        const { server, sync, chat } = await opened()
        server.stored = { ...server.stored, message: server.stored.message.map((m: any, i: number) => (i === 0 ? msg(0, 'other device') : m)) }
        chat.message.push(msg(60))
        await sync.saveChat('char', 0, 'chat', chat)
        const calls = (server.transport.saveChatContentDelta as any).mock.calls
        expect(calls.at(-2)[4].count).toBe(60)
        expect(calls.at(-1)[4]).toBeNull()
        expect(server.stored).toEqual(chat)
    })

    test('a chat never loaded from the server is saved in full, then as deltas', async () => {
        const server = fakeServer({ ...chatOf(0) })
        const sync = createChatDeltaSync(server.transport, memoryCopies())
        const chat = chatOf(3)
        await sync.saveChat('char', 0, 'chat', chat)
        expect(lastSave(server)[4]).toBeNull()
        chat.message.push(msg(3))
        await sync.saveChat('char', 0, 'chat', chat)
        expect(lastSave(server)[4].count).toBe(3)
        expect(server.stored).toEqual(chat)
    })

    test('clearing the chat saves in full', async () => {
        const { server, sync, chat } = await opened()
        chat.message = []
        await sync.saveChat('char', 0, 'chat', chat)
        expect(lastSave(server)[4]).toBeNull()
        expect(server.stored.message).toEqual([])
    })
})

describe('chat delta sync — save ordering', () => {
    // A slow earlier save (a plugin writing an unopened chat) must not land
    // after a newer one (the autosave after the user opened and edited it).
    test('saves of the same chat reach the server in call order', async () => {
        const server = fakeServer(chatOf(3))
        const order: string[] = []
        let releaseFirst!: () => void
        const firstGate = new Promise<void>((r) => { releaseFirst = r })
        const save = server.transport.saveChatContentDelta as any
        const real = save.getMockImplementation()
        save.mockImplementation(async (a: any, i: any, c: any, chat: any, base: any) => {
            if (chat.note === 'older') await firstGate
            const out = await real(a, i, c, chat, base)
            order.push(chat.note)
            return out
        })
        const sync = createChatDeltaSync(server.transport, memoryCopies())
        const older = sync.saveChat('char', 0, 'chat', chatOf(3, { note: 'older' }))
        const newer = sync.saveChat('char', 0, 'chat', chatOf(4, { note: 'newer' }))
        await settle()
        expect(save).toHaveBeenCalledTimes(1)
        releaseFirst()
        await Promise.all([older, newer])
        expect(order).toEqual(['older', 'newer'])
        expect(server.stored.note).toBe('newer')
        expect(server.stored.message).toHaveLength(4)
    })

    test('a failed save does not block the next one, and other chats are not queued behind it', async () => {
        const server = fakeServer(chatOf(3))
        const save = server.transport.saveChatContentDelta as any
        const real = save.getMockImplementation()
        save.mockImplementationOnce(async () => { throw new Error('network') })
        const sync = createChatDeltaSync(server.transport, memoryCopies())
        const failed = sync.saveChat('char', 0, 'chat', chatOf(3, { note: 'failed' }))
        const next = sync.saveChat('char', 0, 'chat', chatOf(3, { note: 'next' }))
        await expect(failed).rejects.toThrow('network')
        await next
        expect(server.stored.note).toBe('next')

        let release!: () => void
        const gate = new Promise<void>((r) => { release = r })
        save.mockImplementation(async (a: any, i: any, c: any, chat: any, base: any) => {
            if (c === 'slow') await gate
            return real(a, i, c, chat, base)
        })
        const slow = sync.saveChat('char', 0, 'slow', chatOf(1))
        await sync.saveChat('char', 0, 'chat', chatOf(3, { note: 'unblocked' }))
        expect(server.stored.note).toBe('unblocked')
        release()
        await slow
    })
})

// The save loop leaves out a tracked chat the server already holds as it is
// (globalApi persistTrackedChanges): the chat last opened stays tracked after
// every save, and was sent again on every later save (2026-10-21).
describe('chat delta sync — what the server already holds', () => {
    async function saved(n = 60) {
        const server = fakeServer(chatOf(n))
        const sync = createChatDeltaSync(server.transport, memoryCopies())
        const chat = structuredClone(await sync.fetchChat('char', 0, 'chat'))!
        chat.message.push(msg(n))
        await sync.saveChat('char', 0, 'chat', chat)
        return { server, sync, chat }
    }

    test('a chat matches once the server acknowledged its save, never before', async () => {
        const server = fakeServer(chatOf(3))
        const sync = createChatDeltaSync(server.transport, memoryCopies())
        const chat = structuredClone(await sync.fetchChat('char', 0, 'chat'))!
        // Loaded but never saved from this page: nothing to go by.
        expect(sync.savedBodyMatches('char', 'chat', chat)).toBe(false)

        let release!: () => void
        const gate = new Promise<void>((r) => { release = r })
        const real = server.transport.saveChatContentDelta
        server.transport.saveChatContentDelta = vi.fn(async (...args: Parameters<typeof real>) => {
            await gate
            return real(...args)
        })
        chat.message.push(msg(3))
        const pending = sync.saveChat('char', 0, 'chat', chat)
        expect(sync.savedBodyMatches('char', 'chat', chat)).toBe(false)
        release()
        await pending
        expect(sync.savedBodyMatches('char', 'chat', chat)).toBe(true)
        expect(sync.savedBodyMatches('char', 'chat', structuredClone(chat))).toBe(true)
    })

    test('any change, in a message or in any other field, makes it differ', async () => {
        const { sync, chat } = await saved()
        const changed = (edit: (copy: any) => void) => {
            const copy = structuredClone(chat)
            edit(copy)
            return !sync.savedBodyMatches('char', 'chat', copy)
        }
        expect(changed((c) => { c.message[5].data = 'edited' })).toBe(true)
        expect(changed((c) => { c.message[60].data += '!' })).toBe(true)
        expect(changed((c) => { c.message.push(msg(61)) })).toBe(true)
        expect(changed((c) => { c.message.splice(10, 1) })).toBe(true)
        expect(changed((c) => { c.message[3].swipes = ['a', 'b'] })).toBe(true)
        // Written into a message without a chat edit (an illustration).
        expect(changed((c) => { c.message[60].nodeOnlyIllustrations = [{ id: 'img' }] })).toBe(true)
        expect(changed((c) => { c.note = 'author note' })).toBe(true)
        expect(changed((c) => { c.hypaV3Data = { summaries: [{ text: 'summary' }] } })).toBe(true)
        expect(changed((c) => { c.scriptstate = { hp: 1 } })).toBe(true)
        expect(changed((c) => { c.localLore = [{ key: 'k', content: 'c' }] })).toBe(true)
        expect(changed(() => {})).toBe(false)
    })

    test('a failed save forgets the earlier match', async () => {
        const { server, sync, chat } = await saved()
        server.transport.saveChatContentDelta = vi.fn(async () => { throw new Error('network') })
        const edited = { ...structuredClone(chat), note: 'edited' }
        await expect(sync.saveChat('char', 0, 'chat', edited)).rejects.toThrow('network')
        // Even back to the content saved before: the failed request may or
        // may not have reached the server, so it goes out again.
        expect(sync.savedBodyMatches('char', 'chat', chat)).toBe(false)
        expect(sync.savedBodyMatches('char', 'chat', edited)).toBe(false)
    })

    test("after a full save over another device's copy, the chat as sent matches", async () => {
        const { server, sync, chat } = await saved()
        server.stored = { ...server.stored, message: server.stored.message.map((m: any, i: number) => (i === 0 ? msg(0, 'other device') : m)) }
        chat.message.push(msg(61))
        await sync.saveChat('char', 0, 'chat', chat)
        expect((server.transport.saveChatContentDelta as any).mock.calls.at(-1)[4]).toBeNull()
        expect(server.stored).toEqual(chat)
        expect(sync.savedBodyMatches('char', 'chat', chat)).toBe(true)
    })

    test('a later save decides, and other chats keep their own record', async () => {
        const { sync, chat } = await saved()
        const other = chatOf(2, { id: 'other' })
        await sync.saveChat('char', 1, 'other', other)
        const newer = { ...structuredClone(chat), note: 'newer' }
        await sync.saveChat('char', 0, 'chat', newer)
        expect(sync.savedBodyMatches('char', 'chat', chat)).toBe(false)
        expect(sync.savedBodyMatches('char', 'chat', newer)).toBe(true)
        expect(sync.savedBodyMatches('char', 'other', other)).toBe(true)
        expect(sync.savedBodyMatches('other-char', 'chat', newer)).toBe(false)
    })

    test('copied catalog fields alone do not make it differ; anything else still does', async () => {
        const server = fakeServer(chatOf(5, { lastDate: 1 }))
        const sync = createChatDeltaSync(server.transport, memoryCopies(), { copiedFields: ['name', 'lastDate', 'folderId', 'modules'] })
        const chat = structuredClone(await sync.fetchChat('char', 0, 'chat'))!
        chat.message.push(msg(5))
        await sync.saveChat('char', 0, 'chat', chat)
        // Renamed on another device: the catalog patch lands after the body.
        const renamed = { ...structuredClone(chat), name: 'Renamed', lastDate: 2, folderId: 'f', modules: ['m'] }
        expect(sync.savedBodyMatches('char', 'chat', renamed)).toBe(true)
        expect(sync.savedBodyMatches('char', 'chat', { ...renamed, note: 'and a note' })).toBe(false)
        // Without the option every field counts.
        const strict = createChatDeltaSync(fakeServer(chatOf(5)).transport, memoryCopies())
        strict.rememberServerBody('char', 'chat', chat)
        expect(strict.savedBodyMatches('char', 'chat', renamed)).toBe(false)
    })

    test("the server's copy taken in place of this one matches without a save", async () => {
        const { sync, chat } = await saved()
        const theirs = { ...structuredClone(chat), message: [...chat.message, msg(61, 'from another device')] }
        expect(sync.savedBodyMatches('char', 'chat', theirs)).toBe(false)
        sync.rememberServerBody('char', 'chat', theirs)
        expect(sync.savedBodyMatches('char', 'chat', theirs)).toBe(true)
        expect(sync.savedBodyMatches('char', 'chat', chat)).toBe(false)
    })
})
