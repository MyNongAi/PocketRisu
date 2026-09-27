import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import nodeCrypto from 'node:crypto'
import { MessageChannel } from 'node:worker_threads'

const requireCjs = createRequire(import.meta.url)
const utils = requireCjs('./utils.cjs')
const { computeChatEtag, acceptsChatEtag } = requireCjs('./chat-content-etag.cjs')
const { createPendingChatPayloads } = requireCjs('./pending-chat-payloads.cjs')
const {
    createChatBodyStore,
    chatToStub,
    mergeChatStubWithFullChat,
    deepFreeze,
} = requireCjs('./chat-body-store.cjs')
const { Packr, Unpackr } = requireCjs('msgpackr')

const packr = new Packr({ useRecords: false })
const unpackr = new Unpackr({ useRecords: false, int64AsType: 'number' })
const enc = (value: unknown) => Buffer.from(packr.encode(value))
const HEADER_BYTES = 11

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} }

function memoryKv() {
    const kv = new Map<string, Buffer>()
    return {
        kv,
        kvGet: (key: string) => kv.get(key) ?? null,
        kvSet: (key: string, value: Buffer) => { kv.set(key, Buffer.from(value)) },
        kvDel: (key: string) => { kv.delete(key) },
        kvList: (prefix: string) => Array.from(kv.keys()).filter((key) => key.startsWith(prefix)).sort(),
        kvExists: (key: string) => kv.has(key),
    }
}

function setup(options: Record<string, unknown> = {}) {
    const kv = memoryKv()
    const pending = createPendingChatPayloads(kv)
    const store = createChatBodyStore({ pendingChatPayloads: pending, logger: quietLogger, ...options })
    return { kv, pending, store }
}

function chat(id: string, text: string, extra: Record<string, unknown> = {}) {
    return { id, name: `name-${id}`, lastDate: 1, message: [{ role: 'user', data: text }], note: '', ...extra }
}

// A database as read from disk: every chat inline.
function diskDb(pairs: Record<string, Record<string, any>>) {
    return {
        characters: Object.entries(pairs).map(([chaId, chats]) => ({
            chaId,
            chats: Object.entries(chats).map(([id, body]) => (typeof body === 'string' ? chat(id, body) : body)),
        })),
    }
}

// The catalog the client sees: every chat a stub.
function catalog(pairs: Record<string, string[]>, stubMeta: Record<string, any> = {}) {
    return {
        characters: Object.entries(pairs).map(([chaId, ids]) => ({
            chaId,
            chats: ids.map((id) => ({ id, name: `name-${id}`, _stub: true, lastDate: 1, ...(stubMeta[id] ?? {}) })),
        })),
    }
}

function lastText(store: any, chaId: string, chatId: string) {
    return store.getChat(chaId, chatId)?.message?.at(-1)?.data
}

// Verbatim copy of initChatStore at 5890d6ac9 (server.cjs), the oracle for
// loadFromDatabase / acceptPersistedDatabase parity.
function oracleInitChatStore(dbObj: any, restoreInto: (store: Map<any, Map<any, any>>) => void) {
    const fullChatStore = new Map()
    for (const char of dbObj?.characters ?? []) {
        if (!char?.chaId || !char.chats) continue
        const charChats = new Map()
        for (const chat of char.chats) {
            if (!chat) continue
            const isStub = chat._stub === true
            const hasMessage = Array.isArray(chat.message)
            if (isStub && !hasMessage) continue
            if (isStub && hasMessage) {
                delete chat._stub
            }
            if (!chat.id) {
                chat.id = nodeCrypto.randomUUID()
            }
            charChats.set(chat.id, chat)
        }
        if (charChats.size > 0) {
            fullChatStore.set(char.chaId, charChats)
        }
    }
    restoreInto(fullChatStore)
    return fullChatStore
}

function oracleRestoreInto(pending: any) {
    return (store: Map<any, Map<any, any>>) => {
        for (const { chaId, chatId, chat } of pending.entries()) {
            if (!store.has(chaId)) store.set(chaId, new Map())
            if (!store.get(chaId)!.has(chatId)) store.get(chaId)!.set(chatId, chat)
        }
    }
}

// Store content as { chaId: { chatId: hex bytes } }, for comparisons.
function snapshot(store: any) {
    const out: Record<string, Record<string, string>> = {}
    for (const chaId of store.characterIds()) {
        out[chaId] = {}
        for (const chatId of store.chatIds(chaId)) out[chaId][chatId] = store.getEncoded(chaId, chatId).toString('hex')
    }
    return out
}

function oracleSnapshot(map: Map<any, Map<any, any>>) {
    const out: Record<string, Record<string, string>> = {}
    for (const [chaId, chats] of map) {
        out[chaId] = {}
        for (const [chatId, body] of chats) out[chaId][chatId] = enc(body).toString('hex')
    }
    return out
}

// Internal identity view: which Buffer / version / onDisk / revision each
// entry has, to prove a call changed nothing.
function identity(store: any) {
    const out: any[] = []
    for (const chaId of store.characterIds()) {
        out.push(['rev', chaId, store.revision(chaId)])
        for (const chatId of store.chatIds(chaId)) {
            out.push([chaId, chatId, store.getEncoded(chaId, chatId), store.bodyVersion(chaId, chatId), store.isOnDisk(chaId, chatId)])
        }
    }
    return out
}

function expectSameIdentity(a: any[], b: any[]) {
    expect(b.length).toBe(a.length)
    for (let i = 0; i < a.length; i++) {
        expect(b[i].length).toBe(a[i].length)
        for (let j = 0; j < a[i].length; j++) expect(Object.is(b[i][j], a[i][j])).toBe(true)
    }
}

describe('reads and writes', () => {
    it('stores the packr bytes of the object as given and keeps no reference to it', () => {
        const { store } = setup()
        store.loadFromDatabase(null)
        const body: any = chat('c1', 'hello', { skipped: undefined, nan: NaN, when: new Date(0) })
        const expected = enc(body)
        store.setChat('A', 'c1', body)
        body.message.push({ role: 'user', data: 'mutated after save' })
        body.name = 'changed'
        expect(store.getEncoded('A', 'c1').equals(expected)).toBe(true)
        expect(lastText(store, 'A', 'c1')).toBe('hello')
    })

    it('getChat returns a fresh private copy per call', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { c1: 'hello' } }))
        const a = store.getChat('A', 'c1')
        const b = store.getChat('A', 'c1')
        expect(a).not.toBe(b)
        a.message.push({ role: 'user', data: 'x' })
        expect(store.getChat('A', 'c1').message).toHaveLength(1)
    })

    it('getEncoded is encodeRisuSaveLegacy(chat) without its header, and legacyEncoded is all of it', () => {
        const { store } = setup()
        const body = chat('c1', '안녕', { hypaV3Data: { summaries: [1, 2] }, empty: null })
        store.loadFromDatabase(diskDb({ A: { c1: body } }))
        const legacy = Buffer.from(utils.encodeRisuSaveLegacy(body))
        expect(store.getEncoded('A', 'c1').equals(legacy.subarray(HEADER_BYTES))).toBe(true)
        expect(store.legacyEncoded('A', 'c1').equals(legacy)).toBe(true)
        // Owned exactly: not msgpackr's scratch, not the Buffer pool.
        const bytes = store.getEncoded('A', 'c1')
        expect(bytes.byteOffset).toBe(0)
        expect(bytes.buffer.byteLength).toBe(bytes.length)
    })

    it('etag, bufferEtag and acceptsEtag agree with computeChatEtag and acceptsChatEtag', () => {
        const { store } = setup()
        store.loadFromDatabase(null)
        const body: any = chat('c1', 'hi', { gone: undefined, n: NaN })
        store.setChat('A', 'c1', body)
        expect(store.etag('A', 'c1')).toBe(computeChatEtag(body))
        const legacyMd5 = nodeCrypto.createHash('md5').update(Buffer.from(utils.encodeRisuSaveLegacy(body))).digest('hex')
        expect(store.bufferEtag('A', 'c1')).toBe(legacyMd5)
        for (const expected of [computeChatEtag(body), legacyMd5, 'stale', undefined, 42]) {
            expect(store.acceptsEtag('A', 'c1', expected)).toBe(acceptsChatEtag(expected, body))
        }
        expect(store.acceptsEtag('A', 'missing', computeChatEtag(body))).toBe(false)
        // A caller-supplied ETag is used as is.
        const prepared = store.prepare(chat('c2', 'x'), { etag: 'chat-v2-precomputed' })
        store.commit('A', 'c2', prepared)
        expect(store.etag('A', 'c2')).toBe('chat-v2-precomputed')
    })

    it('an unloaded store fails closed', () => {
        const { store } = setup()
        expect(store.loaded).toBe(false)
        expect(() => store.has('A', 'c1')).toThrow(expect.objectContaining({ code: 'CHAT_STORE_NOT_LOADED' }))
        expect(() => store.getChat('A', 'c1')).toThrow(expect.objectContaining({ code: 'CHAT_STORE_NOT_LOADED' }))
        expect(() => store.hasCharacter('A')).toThrow(expect.objectContaining({ code: 'CHAT_STORE_NOT_LOADED' }))
        expect(() => store.commit('A', 'c1', store.prepare(chat('c1', 'x')))).toThrow(expect.objectContaining({ code: 'CHAT_STORE_NOT_LOADED' }))
        expect(store.characterCount).toBe(0)
        expect(store.stats()).toBeNull()
    })

    it('a detached body buffer is caught before it can be read or persisted', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { c1: 'hello' } }))
        const bytes = store.getEncoded('A', 'c1')
        const { port1, port2 } = new MessageChannel()
        port1.postMessage(bytes, [bytes.buffer])
        port1.close()
        port2.close()
        expect(bytes.length).toBe(0)
        expect(() => store.getChat('A', 'c1')).toThrow(expect.objectContaining({ code: 'CHAT_STORE_CORRUPT' }))
        expect(() => store.encodeMerged('A', { id: 'c1', name: 'x', _stub: true })).toThrow(expect.objectContaining({ code: 'CHAT_STORE_CORRUPT' }))
        const token = store.snapshotToken()
        expect(() => store.acceptPersistedDatabase(diskDb({ A: { c1: 'hello' } }), token)).toThrow(expect.objectContaining({ code: 'CHAT_STORE_CORRUPT' }))
    })

    it('with test hardening, a write into a stored buffer is caught', () => {
        const { store } = setup({ testHardening: true })
        store.loadFromDatabase(diskDb({ A: { c1: 'hello' } }))
        store.getEncoded('A', 'c1')[5] ^= 0xff
        expect(() => store.getChat('A', 'c1')).toThrow(expect.objectContaining({ code: 'CHAT_STORE_CORRUPT' }))
    })

    it('a body that cannot be encoded leaves the store and the journal untouched', () => {
        const { store, kv } = setup()
        store.loadFromDatabase(diskDb({ A: { c1: 'hello' } }))
        const before = identity(store)
        expect(() => store.prepare({ id: 'c1', message: [], huge: 2n ** 80n })).toThrow()
        expect(() => store.prepare(['not', 'a', 'chat'])).toThrow(TypeError)
        expectSameIdentity(before, identity(store))
        expect(kv.kv.size).toBe(0)
    })

    it('scanInlayRefs and jsonLength give the numbers a full decode gives', () => {
        const { store } = setup()
        const chats: Record<string, any> = {
            a: chat('a', 'plain text'),
            b: chat('b', 'see {{inlay::img-1}} and {{inlayed::img-2}}'),
            c: { id: 'c', name: 'c', message: [{ role: 'char', data: '{{inlayeddata::img-1}}' }, { role: 'user', data: 7 }, null] },
            d: { id: 'd', name: 'd', note: '{{inlay::not-a-message}}', message: [{ role: 'user', data: 'x' }] },
            e: { id: 'e', name: 'e' },
        }
        store.loadFromDatabase(diskDb({ A: chats }))
        const inlayRe = /\{\{(?:inlay|inlayed|inlayeddata)::(.+?)\}\}/g
        function count(refCounts: Record<string, number>, list: any[]) {
            let messages = 0
            for (const ch of list) {
                if (!Array.isArray(ch?.message)) continue
                for (const msg of ch.message) {
                    if (typeof msg?.data !== 'string') continue
                    messages++
                    inlayRe.lastIndex = 0
                    let m
                    while ((m = inlayRe.exec(msg.data)) !== null) refCounts[m[1]] = (refCounts[m[1]] ?? 0) + 1
                }
            }
            return messages
        }
        const expected = Object.create(null)
        const expectedMessages = count(expected, Object.values(chats))
        const got = Object.create(null)
        const result = store.scanInlayRefs(got, count)
        expect(result).toEqual({ chats: 5, totalMessages: expectedMessages })
        expect({ ...got }).toEqual({ ...expected })
        for (const [id, body] of Object.entries(chats)) expect(store.jsonLength('A', id)).toBe(JSON.stringify(body).length)
    })

    it('a "__proto__" key is stored as a decode gives it back', () => {
        const { store } = setup()
        store.loadFromDatabase(null)
        const body = JSON.parse('{"id":"p","message":[],"__proto__":{"x":1}}')
        store.setChat('A', 'p', body)
        const bytes = store.getEncoded('A', 'p')
        expect(Buffer.from(packr.encode(unpackr.decode(bytes))).equals(bytes)).toBe(true)
    })
})

describe('loadFromDatabase', () => {
    it('mirrors initChatStore', () => {
        const { store, pending } = setup()
        pending.stage('A', 'journaled', chat('journaled', 'from the journal'))
        pending.stage('A', 'c1', chat('c1', 'journal must not win over disk'))
        const build = () => ({
            characters: [
                { chaId: 'A', chats: [
                    chat('c1', 'disk'),
                    { id: 'stub', name: 's', _stub: true },
                    { id: 'hybrid', name: 'h', _stub: true, message: [{ role: 'user', data: 'hybrid body' }] },
                    { name: 'no id', message: [{ role: 'user', data: 'idless' }] },
                    { id: 'nomsg', name: 'no message array' },
                    null,
                ] },
                { chats: [chat('orphan', 'character without chaId')] },
                { chaId: 'B', chats: [{ id: 'only-stub', _stub: true }] },
            ],
        })
        const mine = build()
        const theirs = build()
        store.loadFromDatabase(mine)
        const oracle = oracleInitChatStore(theirs, oracleRestoreInto(pending))
        // Fixed in place like before: the hybrid lost its flag, the idless chat got an id.
        expect('_stub' in mine.characters[0].chats[2]).toBe(false)
        const newId = mine.characters[0].chats[3].id
        expect(typeof newId).toBe('string')
        // Same content (random ids aside).
        const theirsId = theirs.characters[0].chats[3].id
        const oracleMap = oracleSnapshot(oracle)
        oracleMap.A[newId] = enc({ ...theirs.characters[0].chats[3], id: newId }).toString('hex')
        delete oracleMap.A[theirsId]
        expect(snapshot(store)).toEqual(oracleMap)
        expect(store.hasCharacter('B')).toBe(false)
        expect(lastText(store, 'A', 'c1')).toBe('disk')
        expect(store.isOnDisk('A', 'c1')).toBe(true)
        expect(store.isOnDisk('A', 'journaled')).toBe(false)
    })

    it('fixes only its own copy when fixInPlace is false', () => {
        const { store } = setup()
        const db = diskDb({ A: { h: { id: 'h', _stub: true, message: [] }, n: { message: [] } } })
        deepFreeze(db)
        store.loadFromDatabase(db, { fixInPlace: false })
        expect(store.getChat('A', 'h')).toEqual({ id: 'h', message: [] })
        expect(store.chatIds('A')).toHaveLength(2)
    })

    it('keeps the bodies of every duplicate chaId', () => {
        const { store } = setup()
        store.loadFromDatabase({ characters: [
            { chaId: 'A', chats: [chat('c1', 'first copy')] },
            { chaId: 'A', chats: [chat('c2', 'second copy')] },
        ] })
        expect(store.chatIds('A').sort()).toEqual(['c1', 'c2'])
    })

    it('lets a journaled body replace an archive-row body for a chat that is bodiless on disk', () => {
        const { store, pending } = setup()
        pending.stage('A', 'c1', chat('c1', 'journaled, newer'))
        pending.stage('A', 'c2', chat('c2', 'journaled for a chat with a disk body'))
        const fromDisk = { characters: [{ chaId: 'A', chats: [{ id: 'c1', _stub: true }, chat('c2', 'disk body')] }] }
        const withRows = { characters: [{ chaId: 'A', chats: [chat('c1', 'archive row'), chat('c2', 'disk body')] }] }
        store.loadFromDatabase(withRows, { pendingOverridesBodilessStubsOf: fromDisk })
        expect(lastText(store, 'A', 'c1')).toBe('journaled, newer')
        expect(lastText(store, 'A', 'c2')).toBe('disk body')
    })

    it('an invalid journal record fails the load and keeps the previous store', () => {
        const { store, kv } = setup()
        store.loadFromDatabase(diskDb({ A: { c1: 'kept' } }))
        const before = identity(store)
        kv.kvSet('chat-payload-pending/' + Buffer.from(JSON.stringify(['A', 'x'])).toString('hex'), Buffer.from(packr.encode({ chaId: 'A', chatId: 'y', chat: {} })))
        expect(() => store.loadFromDatabase(diskDb({ A: { c1: 'replacement' } }))).toThrow(/Invalid pending chat payload/)
        expectSameIdentity(before, identity(store))
        expect(lastText(store, 'A', 'c1')).toBe('kept')
    })

    it('a reload keeps unchanged buffers and every body that is not on disk', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { c1: 'v1', c2: 'same' } }))
        const same = store.getEncoded('A', 'c2')
        const sameVersion = store.bodyVersion('A', 'c2')
        store.setChat('A', 'c1', chat('c1', 'acknowledged'))
        store.loadFromDatabase(diskDb({ A: { c1: 'v1', c2: 'same' } }))
        expect(lastText(store, 'A', 'c1')).toBe('acknowledged')
        expect(store.isOnDisk('A', 'c1')).toBe(false)
        expect(store.getEncoded('A', 'c2')).toBe(same)
        expect(store.bodyVersion('A', 'c2')).toBe(sameVersion)
    })
})

describe('encodeMerged', () => {
    function withBody(body: any) {
        const { store } = setup()
        store.loadFromDatabase(null)
        store.setChat('A', body.id, body)
        return store
    }
    const slow = (store: any, stub: any) => enc(mergeChatStubWithFullChat(stub, store.getChat('A', stub.id)))

    it('reuses the stored buffer exactly when the merge changes nothing', () => {
        const body = chat('c1', 'x', { folderId: null, modules: ['m1'] })
        const cases: Array<[string, any, boolean]> = [
            ['same metadata', chatToStub(body), true],
            ['not a stub (the merge returns the body)', { id: 'c1', name: 'other' }, true],
            ['renamed', { ...chatToStub(body), name: 'renamed' }, false],
            ['lastDate changed', { ...chatToStub(body), lastDate: 2 }, false],
            ['folderId set', { ...chatToStub(body), folderId: 'f1' }, false],
            ['folderId absent from the stub', (() => { const s: any = chatToStub(body); delete s.folderId; return s })(), true],
            ['modules changed', { ...chatToStub(body), modules: ['m2'] }, false],
            ['modules cleared to null', { ...chatToStub(body), modules: null }, false],
            ['stub name undefined vs body name', { ...chatToStub(body), name: undefined }, false],
        ]
        const store = withBody(body)
        for (const [label, stub, reused] of cases) {
            const result = store.encodeMerged('A', stub)
            expect(result.reused, label).toBe(reused)
            expect(result.bytes.equals(slow(store, stub)), label).toBe(true)
            expect(result.hasMessageArray, label).toBe(true)
            if (reused) expect(result.bytes, label).toBe(store.getEncoded('A', 'c1'))
        }
        // Keys the body lacks are appended by the merge.
        const bare = withBody({ id: 'c1', message: [] })
        const stub = { id: 'c1', name: 'n', _stub: true, lastDate: 5 }
        expect(bare.encodeMerged('A', stub).reused).toBe(false)
        expect(bare.encodeMerged('A', stub).bytes.equals(slow(bare, stub))).toBe(true)
        // A body carrying `_stub` (false) loses it in the merge.
        const flagged = withBody({ id: 'c1', name: 'n', _stub: false, message: [] })
        expect(flagged.encodeMerged('A', { id: 'c1', name: 'n', _stub: true }).reused).toBe(false)
        // A body without a message array.
        const noMessage = withBody({ id: 'c1', name: 'n' })
        expect(noMessage.encodeMerged('A', { id: 'c1', name: 'n', _stub: true }).hasMessageArray).toBe(false)
        expect(withBody(body).encodeMerged('A', { id: 'missing', _stub: true })).toBeUndefined()
    })

    it('is not fooled by a stub that shares an array with the body and was edited in place', () => {
        const { store } = setup()
        const body = { id: 'c1', name: 'n', modules: ['m1'], message: [] as any[] }
        const db = { characters: [{ chaId: 'A', chats: [body] }] }
        store.loadFromDatabase(db)
        const stub: any = chatToStub(body)
        expect(stub.modules).toBe(body.modules)
        stub.modules.push('m2')
        const result = store.encodeMerged('A', stub)
        expect(result.reused).toBe(false)
        expect(result.bytes.equals(slow(store, stub))).toBe(true)
    })

    it('matches encodeRisuSaveLegacy of the merged object for random stubs and bodies', () => {
        let seed = 20260928
        const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff }
        const pick = <T>(arr: T[]) => arr[Math.floor(rnd() * arr.length)]
        const VALUES = [undefined, null, 0, -0, 1, 1.5, 2 ** 40, NaN, Infinity, '', 'a', 'b', 'f1', [], ['m1'], ['m1', 'm2'], { x: 1 }, true, false, new Date(5)]
        const KEYS = ['id', 'name', 'lastDate', 'folderId', 'modules', 'message', 'note', '_stub', 'hypaV3Data', '0', '10', 'scriptstate']
        let reusedCount = 0
        for (let i = 0; i < 20000; i++) {
            const body: any = {}
            for (const key of KEYS.slice().sort(() => rnd() - 0.5)) {
                if (rnd() > 0.7) continue
                if (key === 'message') body.message = [{ role: 'user', data: 'hi' }]
                else if (key === 'id') body.id = pick(['c1', 'c1', ''])
                else if (key === '_stub') body._stub = pick([false, undefined, 0])
                else body[key] = pick(VALUES)
            }
            if (!body.id) body.id = 'c1'
            const normalized = rnd() < 0.5
            const stored = normalized ? utils.normalizeJSON(body) : body
            const { store } = setup()
            store.loadFromDatabase(null)
            store.setChat('A', 'c1', stored)
            const base: any = rnd() < 0.5 ? chatToStub({ ...stored, _stub: undefined, message: [] }) : { id: 'c1', name: pick(VALUES), _stub: true }
            base._stub = true
            base.id = pick(['c1', 'c1', ''])
            for (const key of ['lastDate', 'folderId', 'modules', 'name']) {
                const r = rnd()
                if (r < 0.2) delete base[key]
                else if (r < 0.4) base[key] = pick(VALUES)
            }
            const stub = rnd() < 0.5 ? utils.normalizeJSON(base) : base
            if (!stub.id) stub.id = 'c1'
            const result = store.encodeMerged('A', stub)
            const merged = mergeChatStubWithFullChat(stub, store.getChat('A', 'c1'))
            const legacy = Buffer.from(utils.encodeRisuSaveLegacy(merged)).subarray(HEADER_BYTES)
            expect(result.bytes.equals(legacy)).toBe(true)
            expect(result.bytes.equals(enc(merged))).toBe(true)
            expect(result.hasMessageArray).toBe(Array.isArray(merged.message))
            if (result.reused) {
                reusedCount++
                expect(result.bytes).toBe(store.getEncoded('A', 'c1'))
            }
        }
        expect(reusedCount).toBeGreaterThan(100)
    })

    it('its bytes appear verbatim in the encoded database', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { c1: 'one', c2: chat('c2', 'two', { folderId: 'f' }) } }))
        const stubs = catalog({ A: ['c1', 'c2'] }, { c2: { name: 'renamed', folderId: null } })
        const fullDb = { settings: { x: 1 }, characters: stubs.characters.map((c) => ({ ...c, chats: c.chats.map((s) => mergeChatStubWithFullChat(s, store.getChat('A', s.id))) })) }
        const whole = Buffer.from(utils.encodeRisuSaveLegacy(fullDb))
        for (const stub of stubs.characters[0].chats) {
            expect(whole.indexOf(store.encodeMerged('A', stub).bytes)).toBeGreaterThan(0)
        }
    })

    it('getMergedChat is the merge of a fresh decode', () => {
        const { store } = setup({ testHardening: true })
        store.loadFromDatabase(diskDb({ A: { c1: 'one' } }))
        const stub = { id: 'c1', name: 'renamed', _stub: true, lastDate: 9 }
        const merged = store.getMergedChat('A', stub)
        expect(merged).toEqual(mergeChatStubWithFullChat(stub, store.getChat('A', 'c1')))
        expect(Object.isFrozen(merged)).toBe(true)
        expect(Object.isFrozen(merged.message)).toBe(true)
        expect(store.getMergedChat('A', { id: 'nope', _stub: true })).toBeUndefined()
    })
})

// The integration review's token model (integ-store-token-model.cjs),
// against the real store: bodies are chats, "written" items are bytes.
describe('token model', () => {
    const writtenOf = (chaId: string, chatId: string, body: any, source?: string) => ({ chaId, chatId, bytes: enc(body), ...(source ? { source } : {}) })

    it('a reload in the middle of a write adopts the written body', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        const token = store.snapshotToken()
        store.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        const v2 = chat('X', 'v2')
        store.acceptPersisted({ token, root: catalog({ A: ['X'] }), written: [writtenOf('A', 'X', v2)] })
        expect(lastText(store, 'A', 'X')).toBe('v2')
        expect(store.isOnDisk('A', 'X')).toBe(true)

        // Object path: same, through acceptPersistedDatabase with an inline body.
        const other = setup().store
        other.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        const t2 = other.snapshotToken()
        other.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        other.acceptPersistedDatabase(diskDb({ A: { X: 'v2' } }), t2, { fixInPlace: true })
        expect(lastText(other, 'A', 'X')).toBe('v2')
        expect(other.isOnDisk('A', 'X')).toBe(true)
    })

    it('a body installed by a successful persist is on disk', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { Y: chat('Y', 'body', { name: 'old-name' }) } }))
        store.acceptPersisted({ token: store.snapshotToken(), root: catalog({ A: ['Y'] }), written: [writtenOf('A', 'Y', chat('Y', 'body', { name: 'renamed' }))] })
        expect(store.stats().dirty).toBe(0)
        expect(store.getChat('A', 'Y').name).toBe('renamed')
    })

    it('an acknowledged body survives reloads until a persist writes it', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        store.setChat('A', 'X', chat('X', 'v2'))
        store.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        store.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        expect(lastText(store, 'A', 'X')).toBe('v2')
        expect(store.isOnDisk('A', 'X')).toBe(false)
        const token = store.snapshotToken()
        store.acceptPersisted({ token, root: catalog({ A: ['X'] }), written: [{ chaId: 'A', chatId: 'X', bytes: store.getEncoded('A', 'X') }] })
        store.loadFromDatabase(diskDb({ A: { X: 'v2' } }))
        expect(lastText(store, 'A', 'X')).toBe('v2')
        expect(store.stats().dirty).toBe(0)
    })

    it('a body committed after the token is kept', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        store.setChat('A', 'X', chat('X', 'v2'))
        const token = store.snapshotToken()
        store.setChat('A', 'X', chat('X', 'v3'))
        store.acceptPersisted({ token, root: catalog({ A: ['X'] }), written: [writtenOf('A', 'X', chat('X', 'v2'))] })
        expect(lastText(store, 'A', 'X')).toBe('v3')
        expect(store.isOnDisk('A', 'X')).toBe(false)
        // Object path too.
        const t2 = setup().store
        t2.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        const token2 = t2.snapshotToken()
        t2.setChat('A', 'X', chat('X', 'v3'))
        t2.acceptPersistedDatabase(diskDb({ A: { X: 'v2' } }), token2)
        expect(lastText(t2, 'A', 'X')).toBe('v3')
        expect(t2.isOnDisk('A', 'X')).toBe(false)
    })

    it('stale copied bytes are refused before and after the write', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        const v1bytes = store.getEncoded('A', 'X')
        store.setChat('A', 'X', chat('X', 'v2'))
        const span = [{ chaId: 'A', chatId: 'X', bytes: v1bytes, source: 'span' }]
        expect(() => store.assertPersistComplete({ root: catalog({ A: ['X'] }), written: span }))
            .toThrow(expect.objectContaining({ code: 'PERSIST_SPAN_STALE' }))
        const token = store.snapshotToken()
        const result = store.acceptPersisted({ token, root: catalog({ A: ['X'] }), written: span })
        expect(result.refused).toBe(1)
        expect(lastText(store, 'A', 'X')).toBe('v2')
        expect(store.isOnDisk('A', 'X')).toBe(false)
    })

    it('a reset makes the token stale and leaves the new store alone', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        const token = store.snapshotToken()
        store.reset()
        store.loadFromDatabase(diskDb({ B: { Z: 'imported' } }))
        const result = store.acceptPersisted({ token, root: catalog({ A: ['X'] }), written: [writtenOf('A', 'X', chat('X', 'v1'))] })
        expect(result.stale).toBe(true)
        expect(store.hasCharacter('A')).toBe(false)
        expect(lastText(store, 'B', 'Z')).toBe('imported')
        // The object path runs synchronously from token to write: a stale token there is a bug, and throws.
        expect(() => store.acceptPersistedDatabase(diskDb({ A: { X: 'v1' } }), token)).toThrow(expect.objectContaining({ code: 'CHAT_STORE_STALE' }))
        expect(store.hasCharacter('A')).toBe(false)
    })

    it('a chat gone from the catalog is dropped, a journaled new chat is kept', () => {
        const { store, pending } = setup()
        store.loadFromDatabase(diskDb({ A: { X: 'v1', D: 'gone' } }))
        pending.stage('A', 'N', chat('N', 'new-chat'))
        store.setChat('A', 'N', chat('N', 'new-chat'))
        const token = store.snapshotToken()
        // N was committed before the token and is not in the catalog yet.
        store.acceptPersisted({ token, root: catalog({ A: ['X'] }), written: [{ chaId: 'A', chatId: 'X', bytes: store.getEncoded('A', 'X'), source: 'span' }] })
        expect(store.has('A', 'D')).toBe(false)
        expect(lastText(store, 'A', 'N')).toBe('new-chat')
        expect(store.isOnDisk('A', 'X')).toBe(true)
    })

    it('assertPersistComplete refuses a plan that drops a held body', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { X: 'v1', Y: 'v1' } }))
        const root = catalog({ A: ['X', 'Y'] })
        expect(() => store.assertPersistComplete({ root, written: [{ chaId: 'A', chatId: 'X', bytes: store.getEncoded('A', 'X') }] }))
            .toThrow(expect.objectContaining({ code: 'CHAT_BODY_DROP' }))
        expect(() => store.assertPersistComplete({ root, written: ['X', 'Y'].map((id) => ({ chaId: 'A', chatId: id, bytes: store.getEncoded('A', id) })) })).not.toThrow()
    })
})

describe('acceptPersisted is all or nothing', () => {
    it('an item that does not decode to a chat changes nothing', () => {
        const { store, pending, kv } = setup()
        store.loadFromDatabase(diskDb({ A: { X: 'v1', Y: 'v1', D: 'to be dropped' } }))
        pending.stage('A', 'Y', chat('Y', 'v2'))
        store.setChat('A', 'Y', chat('Y', 'v2'))
        const before = identity(store)
        const journal = kv.kvList('chat-payload-pending/')
        const written = [
            { chaId: 'A', chatId: 'X', bytes: enc(chat('X', 'v2')) },
            { chaId: 'A', chatId: 'Y', bytes: store.getEncoded('A', 'Y') },
            { chaId: 'A', chatId: 'Z', bytes: enc('not a chat') },
        ]
        expect(() => store.acceptPersisted({ token: store.snapshotToken(), root: catalog({ A: ['X', 'Y', 'Z'] }), written }))
            .toThrow(expect.objectContaining({ code: 'CHAT_STORE_BAD_WRITTEN' }))
        expectSameIdentity(before, identity(store))
        expect(kv.kvList('chat-payload-pending/')).toEqual(journal)
        // Truncated msgpack.
        const truncated = [{ chaId: 'A', chatId: 'X', bytes: enc(chat('X', 'v2')).subarray(0, 10) }]
        expect(() => store.acceptPersisted({ token: store.snapshotToken(), root: catalog({ A: ['X'] }), written: truncated })).toThrow()
        expectSameIdentity(before, identity(store))
    })

    it('a failure to retire the journal changes nothing', () => {
        const { store, pending } = setup()
        store.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        pending.stage('A', 'X', chat('X', 'v2'))
        store.setChat('A', 'X', chat('X', 'v2'))
        const before = identity(store)
        pending.retireCommittedPairs = () => { throw new Error('kv unavailable') }
        expect(() => store.acceptPersisted({ token: store.snapshotToken(), root: catalog({ A: ['X'] }), written: [{ chaId: 'A', chatId: 'X', bytes: store.getEncoded('A', 'X') }] }))
            .toThrow('kv unavailable')
        expectSameIdentity(before, identity(store))
    })

    it('acceptPersistedDatabase: a failure to retire the journal changes neither the store nor fullDb', () => {
        const { store, pending } = setup()
        store.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        const before = identity(store)
        pending.retireCommitted = () => { throw new Error('injected') }
        const fullDb: any = { characters: [{ chaId: 'A', chats: [
            chat('X', 'v2'),
            { id: 'H', _stub: true, message: [] },
            { name: 'idless', message: [] },
        ] }] }
        const copy = structuredClone(fullDb)
        expect(() => store.acceptPersistedDatabase(fullDb, store.snapshotToken(), { fixInPlace: true })).toThrow('injected')
        expectSameIdentity(before, identity(store))
        expect(fullDb).toEqual(copy)
    })
})

describe('bodyVersion', () => {
    it('changes exactly when the body bytes change', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        const v0 = store.bodyVersion('A', 'X')
        const b0 = store.getEncoded('A', 'X')
        expect(Number.isInteger(v0)).toBe(true)

        // Commit of identical bytes: same buffer, same version, but not on disk until written.
        store.setChat('A', 'X', chat('X', 'v1'))
        expect(store.bodyVersion('A', 'X')).toBe(v0)
        expect(store.getEncoded('A', 'X')).toBe(b0)
        expect(store.isOnDisk('A', 'X')).toBe(false)

        // Marked on disk by a persist of those bytes.
        store.acceptPersisted({ token: store.snapshotToken(), root: catalog({ A: ['X'] }), written: [{ chaId: 'A', chatId: 'X', bytes: b0 }] })
        expect(store.isOnDisk('A', 'X')).toBe(true)
        expect(store.bodyVersion('A', 'X')).toBe(v0)

        // An object-path persist that merged without changes.
        const stubs = catalog({ A: ['X'] })
        const fullDb = { characters: stubs.characters.map((c) => ({ ...c, chats: c.chats.map((s) => store.getMergedChat('A', s)) })) }
        store.acceptPersistedDatabase(fullDb, store.snapshotToken())
        expect(store.bodyVersion('A', 'X')).toBe(v0)
        expect(store.getEncoded('A', 'X')).toBe(b0)

        // A reload that reads back identical bytes.
        store.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        expect(store.bodyVersion('A', 'X')).toBe(v0)
        expect(store.getEncoded('A', 'X')).toBe(b0)

        // A reload that keeps an unwritten body.
        store.setChat('A', 'X', chat('X', 'v2'))
        const v2 = store.bodyVersion('A', 'X')
        expect(v2).not.toBe(v0)
        store.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        expect(store.bodyVersion('A', 'X')).toBe(v2)

        // A persist that installs merged bytes (a rename) changes it.
        const renamed = catalog({ A: ['X'] }, { X: { name: 'renamed' } })
        const fullDb2 = { characters: renamed.characters.map((c) => ({ ...c, chats: c.chats.map((s) => store.getMergedChat('A', s)) })) }
        store.acceptPersistedDatabase(fullDb2, store.snapshotToken())
        const v3 = store.bodyVersion('A', 'X')
        expect(v3).not.toBe(v2)
        expect(store.getChat('A', 'X').name).toBe('renamed')
        expect(store.isOnDisk('A', 'X')).toBe(true)

        // After a reset, bodies read again are new buffers.
        store.reset()
        store.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        expect(store.bodyVersion('A', 'X')).not.toBe(v3)
    })

    it('revision changes on every change of a character and never repeats', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { X: 'v1' }, B: { Y: 'v1' } }))
        const seen = new Set<number>()
        const record = (value: number) => { expect(seen.has(value)).toBe(false); seen.add(value) }
        const r0 = store.revision('A')
        record(r0)
        expect(store.revision('B')).toBe(r0)
        store.setChat('A', 'X', chat('X', 'v2'))
        const r1 = store.revision('A')
        record(r1)
        expect(store.revision('B')).toBe(r0)
        store.setChat('A', 'X', chat('X', 'v2')) // identical bytes: no change
        expect(store.revision('A')).toBe(r1)
        store.replaceCharacter('C', [])
        record(store.revision('C'))
        store.loadFromDatabase(diskDb({ A: { X: 'v1' } }))
        record(store.revision('A'))
        store.reset()
        record(store.revision('A'))
    })
})

describe('acceptPersistedDatabase', () => {
    it('leaves the store as the old retireCommitted + initChatStore(fullDb) did', () => {
        const { store, pending } = setup()
        store.loadFromDatabase(diskDb({ A: { c1: 'v1', gone: 'deleted chat' }, B: { b1: 'v1' } }))
        pending.stage('A', 'new', chat('new', 'journaled, catalog pending'))
        store.setChat('A', 'new', chat('new', 'journaled, catalog pending'))
        pending.stage('B', 'reg', chat('reg', 'journaled and now registered'))
        store.setChat('B', 'reg', chat('reg', 'journaled and now registered'))
        const token = store.snapshotToken()
        const build = () => ({
            characters: [
                { chaId: 'A', chats: [
                    mergeChatStubWithFullChat({ id: 'c1', name: 'renamed', _stub: true }, chat('c1', 'v1')),
                    { id: 'hyb', name: 'h', _stub: true, message: [{ role: 'user', data: 'hybrid' }] },
                    { name: 'idless', message: [{ role: 'user', data: 'idless' }] },
                    { id: 'bodiless', _stub: true },
                ] },
                { chaId: 'B', chats: [chat('b1', 'v1'), chat('reg', 'journaled and now registered')] },
            ],
        })
        const mine = build()
        const theirs = build()
        store.acceptPersistedDatabase(mine, token, { fixInPlace: true })
        pending.retireCommitted(theirs) // what the old code ran first (a no-op now: already retired)
        const oracle = oracleInitChatStore(theirs, oracleRestoreInto(pending))
        const oracleMap = oracleSnapshot(oracle)
        // The random id differs.
        const myId = mine.characters[0].chats[2].id
        const theirId = theirs.characters[0].chats[2].id
        oracleMap.A[myId] = oracleMap.A[theirId]
        delete oracleMap.A[theirId]
        oracleMap.A[myId] = enc({ ...theirs.characters[0].chats[2], id: myId }).toString('hex')
        expect(snapshot(store)).toEqual(oracleMap)
        // Journal: the registered chat retired, the pending one kept.
        expect(pending.pairs()).toEqual([['A', 'new']])
        // fixInPlace: the hybrid and idless chat were fixed on fullDb like before.
        expect('_stub' in mine.characters[0].chats[1]).toBe(false)
        expect(myId).toBeTruthy()
    })

    it('never touches fullDb when fixInPlace is false (it shares chats with the cached root)', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { c1: 'v1' } }))
        const fullDb = deepFreeze({ characters: [{ chaId: 'A', chats: [
            store.getMergedChat('A', { id: 'c1', name: 'name-c1', _stub: true, lastDate: 1 }),
            { id: 'hyb', name: 'h', _stub: true, message: [{ role: 'user', data: 'hybrid' }] },
            { name: 'idless', message: [{ role: 'user', data: 'idless' }] },
        ] }] })
        expect(() => store.acceptPersistedDatabase(fullDb, store.snapshotToken())).not.toThrow()
        expect(store.getChat('A', 'hyb')).toEqual({ id: 'hyb', name: 'h', message: [{ role: 'user', data: 'hybrid' }] })
        expect(store.chatIds('A')).toHaveLength(3)
    })

    it('prune: false keeps bodies the written catalog does not list', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { c1: 'v1', c2: 'v1' } }))
        store.replaceCharacter('Z', [chat('z1', 'activated')])
        store.acceptPersistedDatabase(diskDb({ A: { c1: 'v1' } }), store.snapshotToken(), { fixInPlace: true, prune: false })
        expect(store.has('A', 'c2')).toBe(true)
        expect(lastText(store, 'Z', 'z1')).toBe('activated')
        store.acceptPersistedDatabase(diskDb({ A: { c1: 'v1' } }), store.snapshotToken())
        expect(store.has('A', 'c2')).toBe(false)
        expect(store.hasCharacter('Z')).toBe(false)
    })

    it('an empty registration survives only a persist whose token predates it', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { c1: 'v1' } }))
        const early = store.snapshotToken()
        store.replaceCharacter('Z', [{ id: 'z', _stub: true }])
        expect(store.hasCharacter('Z')).toBe(true)
        store.acceptPersistedDatabase(diskDb({ A: { c1: 'v1' } }), early)
        expect(store.hasCharacter('Z')).toBe(true)
        store.acceptPersistedDatabase(diskDb({ A: { c1: 'v1' } }), store.snapshotToken())
        expect(store.hasCharacter('Z')).toBe(false)
    })

    it('restores a journaled body the store lost to /activate', () => {
        const { store, pending } = setup()
        store.loadFromDatabase(null)
        pending.stage('Z', 'n', chat('n', 'journaled'))
        store.setChat('Z', 'n', chat('n', 'journaled'))
        store.replaceCharacter('Z', [chat('z1', 'activated')])
        expect(store.has('Z', 'n')).toBe(false)
        store.acceptPersistedDatabase({ characters: [{ chaId: 'Z', chats: [chat('z1', 'activated')] }] }, store.snapshotToken())
        expect(lastText(store, 'Z', 'n')).toBe('journaled')
    })
})

describe('stored bytes on the persist path', () => {
    const { StoredChatBytes, STORED_CHAT_EXT_TYPE } = requireCjs('./chat-body-store.cjs')

    function randomDatabase(seed: number, bodyKb: number[]) {
        let s = seed
        const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff }
        const characters = bodyKb.map((kb, ci) => ({
            chaId: `char-${ci}`,
            name: `c${ci}`,
            chatPage: ci,
            chats: [0, 1, 2].map((j) => {
                const text = 'ㄱ가나다 abc '.repeat(Math.max(1, Math.floor((kb * 1024) / 16)))
                const body: any = { id: `chat-${ci}-${j}`, name: `n${j}`, lastDate: j, folderId: rnd() < 0.5 ? null : 'f', message: [{ role: 'user', data: text.slice(0, Math.floor(rnd() * text.length)) }], note: '', hypaV3Data: { summaries: [] } }
                if (rnd() < 0.3) body.modules = ['m1']
                if (rnd() < 0.2) delete body.lastDate
                return body
            }),
        }))
        return { settings: { a: 1, b: 'x'.repeat(100) }, characters, tail: [1, 2, 3] }
    }

    it('encodes a database exactly like the merged objects it stands for', () => {
        for (const [seed, sizes] of [[1, [0, 1, 2]], [2, [7, 8, 9, 3]], [3, Array.from({ length: 20 }, (_, i) => 1 + (i * 37) % 900)], [4, [6000, 6000, 6000]]] as Array<[number, number[]]>) {
            const disk = randomDatabase(seed, sizes)
            const { store } = setup()
            store.loadFromDatabase(structuredClone(disk))
            // Some stubs match their body, some do not (renamed).
            const stubbed = {
                ...disk,
                characters: disk.characters.map((c) => ({ ...c, chats: c.chats.map((ch: any, j: number) => ({ ...chatToStub(ch), ...(j === 1 ? { name: 'renamed' } : {}) })) })),
            }
            const merged = { ...stubbed, characters: stubbed.characters.map((c) => ({ ...c, chats: c.chats.map((st: any) => store.getMergedChat(c.chaId, st)) })) }
            const spliced = { ...stubbed, characters: stubbed.characters.map((c) => ({ ...c, chats: c.chats.map((st: any) => store.getMergedChatForDisk(c.chaId, st)) })) }
            const kinds = spliced.characters.flatMap((c) => c.chats.map((ch: any) => ch instanceof StoredChatBytes))
            expect(kinds.filter(Boolean).length).toBeGreaterThan(0)
            expect(kinds.filter((k) => !k).length).toBeGreaterThan(0)
            const a = Buffer.from(utils.encodeRisuSaveLegacy(merged))
            const b = Buffer.from(utils.encodeRisuSaveLegacy(spliced))
            expect(b.equals(a)).toBe(true)
            expect(utils.encodeRisuSaveLegacyBuffer(spliced).equals(a)).toBe(true)
        }
    })

    it('only stands in for no-op merges, and data carrying its type code still fails to decode', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { c1: 'one' } }))
        const same = store.getMergedChatForDisk('A', { id: 'c1', name: 'name-c1', _stub: true, lastDate: 1 })
        expect(same).toBeInstanceOf(StoredChatBytes)
        expect(same.hasMessageArray).toBe(true)
        expect(Object.isFrozen(same)).toBe(true)
        const renamed = store.getMergedChatForDisk('A', { id: 'c1', name: 'other', _stub: true })
        expect(renamed).not.toBeInstanceOf(StoredChatBytes)
        expect(renamed.name).toBe('other')
        expect(store.getMergedChatForDisk('A', { id: 'none', _stub: true })).toBeUndefined()
        const ext = Buffer.from([0xd4, STORED_CHAT_EXT_TYPE, 0])
        expect(() => unpackr.decode(ext)).toThrow(`Unknown extension type ${STORED_CHAT_EXT_TYPE}`)
    })

    it('a detached body cannot be encoded', () => {
        const { store } = setup()
        store.loadFromDatabase(diskDb({ A: { c1: 'one' } }))
        const standIn = store.getMergedChatForDisk('A', { id: 'c1', name: 'name-c1', _stub: true, lastDate: 1 })
        const bytes = store.getEncoded('A', 'c1')
        const { port1, port2 } = new MessageChannel()
        port1.postMessage(bytes, [bytes.buffer])
        port1.close()
        port2.close()
        expect(() => utils.encodeRisuSaveLegacy({ characters: [{ chaId: 'A', chats: [standIn] }] })).toThrow(expect.objectContaining({ code: 'CHAT_STORE_CORRUPT' }))
    })

    it('acceptPersistedDatabase keeps the stored body and retires the journal like the merged object would', () => {
        const { store, pending } = setup()
        store.loadFromDatabase(diskDb({ A: { c1: 'one', bare: { id: 'bare', name: 'b' } } }))
        pending.stage('A', 'c1', chat('c1', 'one'))
        pending.stage('A', 'bare', { id: 'bare', name: 'b', message: [] })
        const before = store.getEncoded('A', 'c1')
        const version = store.bodyVersion('A', 'c1')
        const fullDb = { characters: [{ chaId: 'A', chats: [
            store.getMergedChatForDisk('A', { id: 'c1', name: 'name-c1', _stub: true, lastDate: 1 }),
            store.getMergedChatForDisk('A', { id: 'bare', name: 'b', _stub: true }),
        ] }] }
        expect(fullDb.characters[0].chats.every((c: any) => c instanceof StoredChatBytes)).toBe(true)
        store.acceptPersistedDatabase(fullDb, store.snapshotToken())
        expect(store.getEncoded('A', 'c1')).toBe(before)
        expect(store.bodyVersion('A', 'c1')).toBe(version)
        expect(store.isOnDisk('A', 'c1')).toBe(true)
        // c1 was written with a message array: retired. `bare` has none: kept, as retireCommitted decides.
        expect(pending.pairs()).toEqual([['A', 'bare']])
    })
})

describe('pending chat payloads', () => {
    it('pairs lists journaled chats without reading them, and retireCommittedPairs deletes only those', () => {
        const kv = memoryKv()
        let reads = 0
        const pending = createPendingChatPayloads({ ...kv, kvGet: (key: string) => { reads++; return kv.kvGet(key) } })
        pending.stage('A', 'x', chat('x', '1'))
        pending.stage('A', 'y', chat('y', '1'))
        pending.stage('B', 'x', chat('x', '1'))
        expect(pending.pairs().sort()).toEqual([['A', 'x'], ['A', 'y'], ['B', 'x']])
        expect(reads).toBe(0)
        pending.retireCommittedPairs([{ chaId: 'A', chatId: 'y' }, { chaId: 'C', chatId: 'none' }])
        expect(pending.pairs().sort()).toEqual([['A', 'x'], ['B', 'x']])
    })
})
