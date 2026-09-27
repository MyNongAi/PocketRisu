/**
 * db-persister.cjs against the reference encoder.
 *
 * The oracle is what server.cjs's reference path writes for the same state:
 * encodeRisuSaveLegacyBuffer of hydrateDatabaseForDisk(root) (chat bodies
 * merged from the real ChatBodyStore, asset manifests expanded from a real
 * asset manifest store), with the archive-row fill applied — the reference
 * functions are copied below from server.cjs. Every persist in every test is
 * checked three ways: the blob in the chunk store is byte-identical to the
 * oracle, its manifest is exactly cdcSplit of those bytes, and the plan's
 * guard inputs (losses, written) are exactly what the reference computes.
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'

const requireCjs = createRequire(import.meta.url)
const utils = requireCjs('./utils.cjs')
const { createChunkStore, cdcSplit, chunkStarts } = requireCjs('./chunkStore.cjs')
const { createAssetManifestStore } = requireCjs('./assetManifestStore.cjs')
const { stripAssetManifests, hydrateAssetManifests } = requireCjs('./assetManifestMigration.cjs')
const { createPendingChatPayloads } = requireCjs('./pending-chat-payloads.cjs')
const { createChatBodyStore, chatToStub, mergeChatStubWithFullChat, StoredChatBytes, deepFreeze } = requireCjs('./chat-body-store.cjs')
const { createDbPersister, createPieceWriter, planChunks, walkPlan } = requireCjs('./db-persister.cjs')
const { Packr } = requireCjs('msgpackr')

const KEY = 'database/database.bin'
const packr = new Packr({ useRecords: false })
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

function memoryKv() {
    const kv = new Map<string, Buffer>()
    return {
        kvGet: (key: string) => kv.get(key) ?? null,
        kvSet: (key: string, value: Buffer) => { kv.set(key, Buffer.from(value)) },
        kvDel: (key: string) => { kv.delete(key) },
        kvList: (prefix: string) => Array.from(kv.keys()).filter((key) => key.startsWith(prefix)).sort(),
        kvExists: (key: string) => kv.has(key),
    }
}

function mulberry32(seed: number) {
    return () => {
        seed |= 0
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function harness({ threshold = 1024, audit = {} as Record<string, unknown> } = {}) {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)')
    const chunkStore = createChunkStore(db, { threshold })
    const assetStore = createAssetManifestStore(db)
    const pending = createPendingChatPayloads(memoryKv())
    const store = createChatBodyStore({ pendingChatPayloads: pending, logger: quiet })
    const blob = {
        key: KEY,
        threshold,
        generation: () => chunkStore.generation(KEY),
        isChunked: () => chunkStore.isChunkedKey(KEY),
        readManifestWithLengths: () => chunkStore.readManifestWithLengths(KEY),
        createReader: (chunks: any, options?: any) => chunkStore.createReader(chunks, options),
        commitChunks: (next: any, expected: any, options: any) => chunkStore.commitChunks(KEY, next, expected, options),
        putValue: (value: Buffer) => chunkStore.putValue(KEY, value),
    }

    // ── verbatim from server.cjs ──
    function mapStoredChats(strippedDb: any, mapStub: (chaId: string, chat: any) => any) {
        if (!store.loaded) throw Object.assign(new Error('chat body store is not loaded'), { code: 'CHAT_STORE_NOT_LOADED' })
        const full = { ...strippedDb }
        full.characters = strippedDb.characters.map((char: any) => {
            if (!char?.chaId || !char.chats) return char
            if (!store.hasCharacter(char.chaId)) return char
            return {
                ...char,
                chats: char.chats.map((chat: any) => {
                    if (chat && chat._stub && chat.id) return mapStub(char.chaId, chat) ?? chat
                    return chat
                }),
            }
        })
        return full
    }
    function reassembleFullDb(strippedDb: any, { storedBytes = false } = {}) {
        if (!strippedDb?.characters) return strippedDb
        return mapStoredChats(strippedDb, storedBytes
            ? (chaId, chat) => store.getMergedChatForDisk(chaId, chat)
            : (chaId, chat) => store.getMergedChat(chaId, chat))
    }
    function hydrateDatabaseForDisk(clientDb: any, { storedBytes = false } = {}) {
        return hydrateAssetManifests(reassembleFullDb(clientDb, { storedBytes }), assetStore)
    }
    const lacksArchivedBody = (ch: any) => !!ch && ch._stub === true && !Array.isArray(ch.message)
    function applyArchivedChatBodies(fullDb: any, bodies: Map<string, Map<string, any>>) {
        const result: any = { db: fullDb, restored: [], unresolved: [] }
        const characters = Array.isArray(fullDb?.characters) ? fullDb.characters : null
        if (!characters) return result
        let nextCharacters: any[] | null = null
        for (let i = 0; i < characters.length; i++) {
            const c = characters[i]
            if (!c?.chaId || !Array.isArray(c.chats) || !c.chats.some(lacksArchivedBody)) continue
            const found = bodies.get(c.chaId)
            if (!found) continue
            let restoredHere = 0
            const chats = c.chats.map((ch: any) => {
                if (!lacksArchivedBody(ch)) return ch
                const body = ch.id ? found.get(ch.id) : undefined
                if (!body) {
                    result.unresolved.push(`${c.chaId}/${ch.id || '?'}`)
                    return ch
                }
                result.restored.push(`${c.chaId}/${ch.id}`)
                restoredHere++
                return mergeChatStubWithFullChat(ch, body)
            })
            if (restoredHere > 0) {
                nextCharacters ??= characters.slice()
                nextCharacters[i] = { ...c, chats }
            }
        }
        if (nextCharacters) result.db = { ...fullDb, characters: nextCharacters }
        return result
    }
    function findStubFlagLossChats(fullDb: any) {
        if (!fullDb?.characters) return []
        const losses: any[] = []
        for (let ci = 0; ci < fullDb.characters.length; ci++) {
            const char = fullDb.characters[ci]
            if (!char?.chats) continue
            for (let chi = 0; chi < char.chats.length; chi++) {
                const chat = char.chats[chi]
                if (!chat || typeof chat !== 'object') continue
                const isStub = chat._stub === true
                const hasMessage = chat instanceof StoredChatBytes ? chat.hasMessageArray : Array.isArray(chat.message)
                if (!isStub && !hasMessage) losses.push({ chaId: char.chaId, charIndex: ci, chatIndex: chi, chatId: chat.id || null })
            }
        }
        return losses
    }
    // ── end of the copies ──

    const mismatches: any[] = []
    let currentRoot: any = null
    const persister = createDbPersister({
        blob,
        chatBodyStore: store,
        assetManifestStore: assetStore,
        hydrateAssetManifests,
        mergeChatStubWithFullChat,
        StoredChatBytes,
        hydrateDatabaseForDisk,
        applyArchivedChatBodies,
        logger: quiet,
        audit: { enabled: false, getRoot: () => currentRoot, onMismatch: (m: any) => mismatches.push(m), ...audit },
    })

    function referenceFull(root: any, archivedBodies: any) {
        let full = hydrateDatabaseForDisk(root, { storedBytes: true })
        if (archivedBodies) full = applyArchivedChatBodies(full, archivedBodies).db
        return full
    }

    // What the reference path writes with a body: key -> bytes.
    function referenceWritten(full: any) {
        const out = new Map<string, Buffer>()
        for (const char of full?.characters ?? []) {
            if (!char?.chaId || !Array.isArray(char.chats)) continue
            for (const chat of char.chats) {
                if (!chat || typeof chat !== 'object' || Array.isArray(chat) || !chat.id) continue
                if (chat instanceof StoredChatBytes) out.set(`${char.chaId}/${chat.id}`, chat.body.bytes)
                else if (!(chat._stub === true && !Array.isArray(chat.message))) out.set(`${char.chaId}/${chat.id}`, Buffer.from(packr.encode(chat)))
            }
        }
        return out
    }

    /** Client view of a disk-shaped database, with the store loaded from it. */
    function load(diskDb: any) {
        store.loadFromDatabase(structuredClone(diskDb), { fixInPlace: false })
        const chatStripped = { ...diskDb, characters: diskDb.characters?.map?.((c: any) => (c?.chats && Array.isArray(c.chats) ? { ...c, chats: c.chats.map(chatToStub) } : c)) ?? diskDb.characters }
        return utils.normalizeJSON(stripAssetManifests(chatStripped, assetStore, { activate: true }).db)
    }

    function persist(root: any, mode: 'full-plan' | 'incremental', { archivedBodies = null as any, accept = true } = {}) {
        currentRoot = root
        const prepared = persister.prepare(root, { mode, archivedBodies })
        expect(prepared).not.toBeNull()
        const full = referenceFull(root, archivedBodies)
        expect(prepared.losses).toEqual(findStubFlagLossChats(hydrateDatabaseForDisk(root, { storedBytes: true })))
        if (prepared.losses.length > 0) return { prepared, aborted: true }
        const expectedWritten = referenceWritten(full)
        const written = new Map<string, Buffer>(prepared.written.map((x: any) => [`${x.chaId}/${x.chatId}`, x.bytes]))
        expect([...written.keys()].sort()).toEqual([...expectedWritten.keys()].sort())
        for (const [key, bytes] of written) expect(Buffer.compare(bytes, expectedWritten.get(key)!)).toBe(0)
        for (const x of prepared.written) if (x.source === 'span') expect(x.bytes).toBe(store.getEncoded(x.chaId, x.chatId))
        store.assertPersistComplete({ root, written: prepared.written })
        const expected = utils.encodeRisuSaveLegacyBuffer(full)
        const committed = persister.commit(prepared)
        const actual = chunkStore.getValue(KEY)
        expect(actual.length).toBe(expected.length)
        expect(actual.equals(expected)).toBe(true)
        if (chunkStore.isChunkedKey(KEY)) {
            expect(chunkStore.readManifestWithLengths(KEY).hashes).toEqual(cdcSplit(expected).map((c: any) => c.hash))
        }
        if (accept) store.acceptPersisted({ token: prepared.token, root, written: prepared.written })
        return { prepared, committed, expected }
    }

    return { db, chunkStore, assetStore, store, pending, blob, persister, load, persist, referenceFull, hydrateDatabaseForDisk, mismatches }
}

// ── fixtures ────────────────────────────────────────────────────────────────
let serial = 0
function body(id: string, text: string, extra: Record<string, unknown> = {}) {
    return { id, name: `chat ${id}`, lastDate: 1727400000000, message: [{ role: 'user', data: text, time: 1 }, { role: 'char', data: `${text} (reply) 가나다`, time: 2 }], note: '', localLore: [], ...extra }
}
function asset(i: number) {
    return [`asset-${i}`, `assets/${'a'.repeat(20)}${i}.png`, 'png']
}
function character(chaId: string | undefined, chats: any[], extra: Record<string, unknown> = {}) {
    const c: any = { name: `char ${chaId}`, desc: 'd'.repeat(300), firstMessage: 'hi', chats, chatPage: 0, image: '', type: 'character', ...extra }
    if (chaId !== undefined) c.chaId = chaId
    return c
}
function fixtureDisk() {
    const wide: Record<string, number> = {}
    for (let i = 0; i < 20; i++) wide[`k${i}`] = i
    return {
        10: 'integer-like key',
        formatversion: 3,
        temperature: 80,
        wide,
        characters: [
            character('c1', [body('a', 'first'), body('b', 'second', { folderId: 'f1', modules: ['m1'] }), { id: 'gone', name: 'bodiless', _stub: true, lastDate: 5 }],
                { chatFolders: [{ id: 'f1', name: 'folder' }], additionalAssets: Array.from({ length: 18 }, (_, i) => asset(i)) }),
            character('c2', Array.from({ length: 17 }, (_, i) => body(`c2-${i}`, `line ${i} ${'x'.repeat(i * 40)}`, i % 3 === 0 ? { lastDate: null } : {}))),
            null,
            character(undefined, [body('noid', 'a character without a chaId')]),
            character('c3', []),
            character('c4', [body('h', 'hybrid on disk', { _stub: true })]),
            JSON.parse('{"chaId":"c5","name":"proto","__proto__":{"x":1},"chats":[]}'),
            character('c6', [body('only', 'x'.repeat(70_000))]),
        ],
        modules: [
            { id: 'm1', name: 'module one', lorebook: [{ key: 'k', content: 'lore' }], assets: [asset(1), asset(2)] },
            { id: 'm2', name: 'module two', lorebook: [], assets: [] },
            null,
        ],
        personas: [
            { id: 'p1', name: 'persona', embeddedModule: { id: 'pm', assets: [asset(9)] } },
            { id: 'p2', name: 'plain persona' },
        ],
        botPresets: [{ name: 'preset', temperature: 70, text: '한국어 텍스트' }],
        emptyList: [],
        nothing: null,
    }
}

// B2-style edits: a new root, the touched character cloned, everything else shared.
function withCharacter(root: any, index: number, edit: (c: any) => void) {
    const characters = root.characters.slice()
    const c = structuredClone(characters[index])
    edit(c)
    characters[index] = c
    return { ...root, characters }
}

describe('byte identity with the reference encoder', () => {
    for (const mode of ['full-plan', 'incremental'] as const) {
        it(`${mode}: a varied database and a sequence of edits`, () => {
            const h = harness()
            let root = h.load(fixtureDisk())
            h.persist(root, mode)
            h.persist(root, mode) // no-op
            // chat turn
            h.store.setChat('c1', 'a', { ...h.store.getChat('c1', 'a'), message: [...h.store.getChat('c1', 'a').message, { role: 'user', data: 'turn', time: 3 }] })
            root = withCharacter(root, 0, (c) => { c.chats[0].lastDate = 1727400009999 })
            h.persist(root, mode)
            // stub metadata that differs from the body (a non-no-op merge)
            root = withCharacter(root, 1, (c) => { c.chats[2].name = 'renamed'; c.chats[3].folderId = null })
            h.persist(root, mode)
            h.persist(root, mode) // the store now holds the merged bodies
            // card edit, module edit, root setting
            root = withCharacter(root, 0, (c) => { c.desc = 'edited' })
            h.persist(root, mode)
            root = { ...root, modules: [{ ...root.modules[0], name: 'module renamed' }, ...root.modules.slice(1)] }
            h.persist(root, mode)
            root = { ...root, temperature: 81 }
            h.persist(root, mode)
            // new chat, character add/delete, reorder
            h.store.setChat('c3', 'new', body('new', 'brand new'))
            root = withCharacter(root, 4, (c) => { c.chats.unshift({ id: 'new', name: 'chat new', _stub: true, lastDate: 7 }) })
            h.persist(root, mode)
            root = { ...root, characters: [character('added', [], { desc: 'added' }), ...root.characters] }
            h.persist(root, mode)
            root = { ...root, characters: root.characters.filter((_: any, i: number) => i !== 2) }
            h.persist(root, mode)
            const swapped = root.characters.slice()
            ;[swapped[1], swapped[5]] = [swapped[5], swapped[1]]
            root = { ...root, characters: swapped }
            h.persist(root, mode)
            // an inline chat and a hybrid put into the catalog by a whole-chat patch
            root = withCharacter(root, 1, (c) => { c.chats.push(body('inline', 'inline chat')); c.chats.push(body('hyb', 'hybrid in catalog', { _stub: true })) })
            h.persist(root, mode)
            h.persist(root, mode)
            // identity lost everywhere
            root = { ...structuredClone(root) }
            h.persist(root, mode)
            h.persist(root, mode)
        })
    }

    it('incremental copies unchanged owners and chunks after the first write', () => {
        const h = harness()
        let root = h.load(fixtureDisk())
        const first = h.persist(root, 'incremental')
        expect(first.committed.stats.spans).toBe(false)
        const second = h.persist(root, 'incremental')
        expect(second.committed.stats.spans).toBe(true)
        expect(second.committed.stats.freshOwners).toBe(0)
        expect(second.committed.stats.newChunks).toBeLessThanOrEqual(2)
        h.store.setChat('c2', 'c2-5', { ...h.store.getChat('c2', 'c2-5'), note: 'changed' })
        root = withCharacter(root, 1, (c) => { c.chats[5].lastDate = 1 })
        const turn = h.persist(root, 'incremental')
        expect(turn.committed.stats.freshChats).toBe(1)
        expect(turn.committed.stats.spanChats).toBe(16)
        expect(turn.committed.stats.commit).toBe('gapped')
    })

    it('incremental leaves gaps and edits few manifest rows', () => {
        const h = harness()
        let root = h.load(fixtureDisk())
        h.persist(root, 'incremental')
        const seqs = h.db.prepare('SELECT seq FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq').pluck().all(KEY)
        expect(seqs[0]).toBe(1024)
        h.store.setChat('c1', 'b', { ...h.store.getChat('c1', 'b'), note: 'n' })
        root = withCharacter(root, 0, (c) => { c.chats[1].lastDate = 2 })
        const r = h.persist(root, 'incremental')
        expect(r.committed.stats.commit).toBe('gapped')
        expect(r.committed.stats.insertedRows).toBeLessThanOrEqual(6)
    })
})

describe('random edit sequences', () => {
    // A seeded run of the edits a client and the server make, persisted after
    // every step (mostly incremental; sometimes full-plan, a write by another
    // path, or an acceptPersisted that never happens).
    function step(h: any, rand: () => number, root: any) {
        const chars = root.characters
        const withChats = chars.map((c: any, i: number) => [c, i]).filter(([c]: any) => c?.chaId && Array.isArray(c.chats) && c.chats.length > 0)
        const r = rand()
        const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)]
        if (r < 0.25 && withChats.length) {
            const [c, i] = pick(withChats)
            const j = Math.floor(rand() * c.chats.length)
            const id = c.chats[j]?.id
            const current = id && h.store.getChat(c.chaId, id)
            if (current) h.store.setChat(c.chaId, id, { ...current, message: [...(current.message ?? []), { role: 'user', data: `turn ${serial++}`, time: serial }] })
            return rand() < 0.8 ? withCharacter(root, i, (cc) => { if (cc.chats[j]) cc.chats[j].lastDate = 1727500000000 + serial++ }) : root
        }
        if (r < 0.35 && withChats.length) {
            const [, i] = pick(withChats)
            const j = Math.floor(rand() * chars[i].chats.length)
            const field = pick(['name', 'folderId', 'modules', 'lastDate'])
            return withCharacter(root, i, (cc) => {
                if (!cc.chats[j]) return
                if (field === 'name') cc.chats[j].name = `renamed ${serial++}`
                else if (field === 'folderId') cc.chats[j].folderId = rand() < 0.5 ? null : 'f1'
                else if (field === 'modules') cc.chats[j].modules = rand() < 0.5 ? [] : ['m1']
                else delete cc.chats[j].lastDate
            })
        }
        if (r < 0.45) {
            const i = Math.floor(rand() * chars.length)
            if (!chars[i] || typeof chars[i] !== 'object' || Array.isArray(chars[i])) return root
            return withCharacter(root, i, (cc) => { cc.desc = `desc ${serial++}` })
        }
        if (r < 0.52 && Array.isArray(root.modules) && root.modules.length) {
            const modules = root.modules.slice()
            const m = Math.floor(rand() * modules.length)
            modules[m] = modules[m] && typeof modules[m] === 'object' ? { ...modules[m], name: `module ${serial++}` } : { id: `mod-${serial++}`, name: 'new' }
            return { ...root, modules }
        }
        if (r < 0.58) return { ...root, temperature: serial++ % 100 }
        if (r < 0.63) {
            const chaId = `new-${serial++}`
            const chatId = `nc-${serial++}`
            h.store.setChat(chaId, chatId, body(chatId, 'first line'))
            const characters = chars.slice()
            characters.splice(Math.floor(rand() * (characters.length + 1)), 0, character(chaId, [{ id: chatId, name: `chat ${chatId}`, _stub: true, lastDate: 1 }]))
            return { ...root, characters }
        }
        if (r < 0.67 && chars.length > 2) {
            const characters = chars.slice()
            characters.splice(Math.floor(rand() * characters.length), 1)
            return { ...root, characters }
        }
        if (r < 0.71 && chars.length > 2) {
            const characters = chars.slice()
            const a = Math.floor(rand() * characters.length)
            const b = Math.floor(rand() * characters.length)
            const t = characters[a]
            characters[a] = characters[b]
            characters[b] = t
            return { ...root, characters }
        }
        if (r < 0.75 && withChats.length) {
            const [c, i] = pick(withChats)
            const chatId = `added-${serial++}`
            h.store.setChat(c.chaId, chatId, body(chatId, 'added chat'))
            return withCharacter(root, i, (cc) => { cc.chats.splice(Math.floor(rand() * (cc.chats.length + 1)), 0, { id: chatId, name: `chat ${chatId}`, _stub: true, lastDate: 2 }) })
        }
        if (r < 0.78 && withChats.length) {
            const [, i] = pick(withChats)
            return withCharacter(root, i, (cc) => { cc.chats.splice(Math.floor(rand() * cc.chats.length), 1) })
        }
        if (r < 0.80) return { ...root, characters: structuredClone(chars) }
        if (r < 0.82 && withChats.length) {
            // A body replaced without any catalog change.
            const [c] = pick(withChats)
            const j = Math.floor(rand() * c.chats.length)
            const id = c.chats[j]?.id
            const current = id && h.store.getChat(c.chaId, id)
            if (current) h.store.setChat(c.chaId, id, { ...current, note: `note ${serial++}` })
            return root
        }
        return root // no-op
    }

    for (let seed = 1; seed <= 60; seed++) {
        it(`seed ${seed}`, () => {
            const rand = mulberry32(seed)
            const h = harness({ threshold: rand() < 0.2 ? 64 * 1024 * 1024 : 1024 })
            let root = h.load(fixtureDisk())
            for (let n = 0; n < 30; n++) {
                root = step(h, rand, root)
                const x = rand()
                if (x < 0.06) {
                    // Another writer (the reference path, an import): moves the generation.
                    h.chunkStore.putValue(KEY, utils.encodeRisuSaveLegacyBuffer(h.referenceFull(root, null)))
                    continue
                }
                const mode = x < 0.15 ? 'full-plan' : 'incremental'
                h.persist(root, mode, { accept: rand() > 0.05 })
            }
        })
    }
})

describe('odd shapes', () => {
    it('characters that are not plain objects, and odd chats, are encoded through the reference functions', () => {
        const h = harness()
        const disk: any = fixtureDisk()
        disk.characters.push([1, 2, 3])
        disk.characters.push('a string')
        disk.characters.push(JSON.parse('{"chaId":"ctor","constructor":"plain data","chats":[{"id":"z","name":"z","message":[{"role":"user","data":"z"}]}]}'))
        let root = h.load(disk)
        for (const mode of ['full-plan', 'incremental', 'incremental'] as const) h.persist(root, mode)
        expect(h.persister.stats().last.oddOwners).toBeGreaterThan(0)
        // chats that is not an array, on a character the store does not hold.
        root = { ...root, characters: [...root.characters, { chaId: 'nostore', name: 'n', chats: { weird: true } }] }
        for (const mode of ['full-plan', 'incremental', 'incremental'] as const) h.persist(root, mode)
    })

    it('a root that is not a plain object, or root arrays of another class, take the reference path', () => {
        const h = harness()
        const root = h.load(fixtureDisk())
        expect(h.persister.prepare(Object.assign(Object.create(null), root), { mode: 'full-plan' })).toBeNull()
        class Characters extends Array {}
        expect(h.persister.prepare({ ...root, characters: Characters.from(root.characters) }, { mode: 'full-plan' })).toBeNull()
        expect(h.persister.prepare({ ...root, characters: { not: 'an array' } }, { mode: 'incremental' })).toBeNull()
        expect(h.persister.prepare(root, { mode: 'reference' as any })).toBeNull()
        expect(h.persister.stats().referencePersists).toMatchObject({ 'root-shape': 1, 'characters-shape': 2 })
    })

    it('the stub-flag-loss guard sees the same losses as the reference', () => {
        const h = harness()
        let root = h.load(fixtureDisk())
        h.persist(root, 'incremental')
        // A body without a message array, and a catalog chat that lost _stub.
        h.store.setChat('c1', 'a', { id: 'a', name: 'no messages' })
        root = withCharacter(root, 1, (c) => { delete c.chats[4]._stub })
        const result = h.persist(root, 'incremental')
        expect(result.aborted).toBe(true)
        expect(result.prepared.losses.map((l: any) => l.chatId)).toEqual(['a', 'c2-4'])
    })

    it('stubs filled from archive rows are written like the reference writes them', () => {
        const h = harness()
        const root = h.load(fixtureDisk())
        const archived = new Map([['c1', new Map([['gone', body('gone', 'from the archive row')]])]])
        const first = h.persist(root, 'incremental', { archivedBodies: archived })
        expect(first.prepared.written.some((x: any) => x.chatId === 'gone')).toBe(true)
        // The store now holds it; the next persist merges it like any body.
        h.persist(root, 'incremental')
        h.persist(root, 'incremental', { archivedBodies: new Map([['c1', new Map()]]) })
    })

    it('a frozen root and frozen store results are never written to', () => {
        const h = harness()
        let root = deepFreeze(h.load(fixtureDisk()))
        for (let n = 0; n < 4; n++) {
            h.persist(root, n % 2 ? 'full-plan' : 'incremental')
            h.persist(root, 'incremental')
            root = deepFreeze(withCharacter(root, 1, (c) => { c.chats[n].lastDate = n }))
        }
    })

    it('a blob at or under the chunk threshold is stored raw, walked first', () => {
        const h = harness({ threshold: 64 * 1024 * 1024 })
        const root = h.load(fixtureDisk())
        const r = h.persist(root, 'incremental')
        expect(r.committed.stats.commit).toBe('raw')
        expect(h.chunkStore.isChunkedKey(KEY)).toBe(false)
        expect(h.persister.hasLayout()).toBe(false)
    })
})

describe('what a commit refuses', () => {
    it('a blob changed behind the layout without a generation change: STALE_LAYOUT, nothing written', () => {
        const h = harness()
        let root = h.load(fixtureDisk())
        h.persist(root, 'incremental')
        // Another connection rewrites one manifest row (no generation bump here).
        const row = h.db.prepare('SELECT seq, hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq LIMIT 1 OFFSET 2').get(KEY) as any
        const other = h.db.prepare('SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq LIMIT 1').get(KEY) as any
        h.db.prepare('UPDATE manifest_chunks SET hash = ? WHERE manifest_key = ? AND seq = ?').run(other.hash, KEY, row.seq)
        const before = h.chunkStore.getValue(KEY)
        root = { ...root, temperature: 1 }
        const prepared = h.persister.prepare(root, { mode: 'incremental' })
        expect(prepared.base).not.toBeNull()
        expect(() => h.persister.commit(prepared)).toThrow(expect.objectContaining({ code: 'STALE_LAYOUT' }))
        expect(h.chunkStore.getValue(KEY).equals(before)).toBe(true)
        expect(h.persister.hasLayout()).toBe(false)
        h.persist(root, 'incremental')
    })

    it('a write through the store moves the generation: the next persist starts over', () => {
        const h = harness()
        const root = h.load(fixtureDisk())
        h.persist(root, 'incremental')
        h.chunkStore.snapshotValue('database/dbbackup-1.bin', KEY) // missing source: a write attempt that changes nothing
        const r = h.persist(root, 'incremental')
        expect(r.committed.stats.spans).toBe(false)
        expect(h.persister.stats().resets.generation).toBe(1)
    })

    it('a copied run that does not start like its owner fails the walk and rolls back', () => {
        const h = harness()
        let root = h.load(fixtureDisk())
        h.persist(root, 'incremental')
        // Corrupt the recorded head of the first character.
        const layout = h.persister._layout()
        const entry = layout.entries.get(root.characters[0])
        entry.head = 'dead'
        const before = h.chunkStore.getValue(KEY)
        const rowsBefore = h.db.prepare('SELECT seq, hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq').all(KEY)
        root = { ...root, temperature: 5 }
        const prepared = h.persister.prepare(root, { mode: 'incremental' })
        expect(() => h.persister.commit(prepared)).toThrow(expect.objectContaining({ code: 'PERSIST_WALK' }))
        expect(h.chunkStore.getValue(KEY).equals(before)).toBe(true)
        expect(h.db.prepare('SELECT seq, hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq').all(KEY)).toEqual(rowsBefore)
        expect(h.persister.stats().walkFailures).toBe(1)
        h.persist(root, 'incremental')
    })

    it('a copied owner whose recorded length is wrong fails the walk', () => {
        const h = harness()
        let root = h.load(fixtureDisk())
        h.persist(root, 'incremental')
        const layout = h.persister._layout()
        const entry = layout.entries.get(root.characters[1])
        entry.len -= 1
        root = { ...root, temperature: 6 }
        const prepared = h.persister.prepare(root, { mode: 'incremental' })
        expect(() => h.persister.commit(prepared)).toThrow(expect.objectContaining({ code: 'PERSIST_WALK' }))
    })

    it('the forced snapshot runs once, before the first commit that copies', () => {
        const h = harness()
        let root = h.load(fixtureDisk())
        let snapshots = 0
        const commit = (mode: any) => {
            const prepared = h.persister.prepare(root, { mode })
            h.persister.commit(prepared, { beforeFirstIncremental: () => { snapshots++ } })
            h.store.acceptPersisted({ token: prepared.token, root, written: prepared.written })
        }
        commit('incremental')
        expect(snapshots).toBe(0)
        commit('incremental')
        expect(snapshots).toBe(1)
        root = { ...root, temperature: 9 }
        commit('incremental')
        expect(snapshots).toBe(1)
    })

    it('a failed forced snapshot writes nothing and drops the layout', () => {
        const h = harness()
        const root = h.load(fixtureDisk())
        h.persist(root, 'incremental')
        const prepared = h.persister.prepare(root, { mode: 'incremental' })
        const before = h.chunkStore.getValue(KEY)
        expect(() => h.persister.commit(prepared, { beforeFirstIncremental: () => { throw new Error('disk full') } })).toThrow('disk full')
        expect(h.chunkStore.getValue(KEY).equals(before)).toBe(true)
        expect(h.persister.hasLayout()).toBe(false)
    })
})

describe('the idle audit', () => {
    it('finds an owner changed in place and reports it', () => {
        const h = harness()
        const root = h.load(fixtureDisk())
        h.persist(root, 'incremental')
        h.persist(root, 'incremental')
        expect(h.persister.auditNow()).toEqual({ ran: true, mismatches: 0 })
        const stats = h.persister.stats().audit
        expect(stats.checkedOwners).toBeGreaterThan(5)
        expect(stats.checkedChats).toBeGreaterThan(5)
        // The invariant broken: a cached module edited in place.
        root.modules[1].name = 'changed in place'
        expect(h.persister.auditNow()).toEqual({ ran: true, mismatches: 1 })
        expect(h.mismatches[0]).toMatchObject({ owner: 'modules' })
        expect(h.persister.hasLayout()).toBe(false)
        // The rewrite the server schedules writes the current state.
        h.persist(root, 'incremental')
    })

    it('finds a character changed in place', () => {
        const h = harness()
        const root = h.load(fixtureDisk())
        h.persist(root, 'incremental')
        root.characters[4].desc = 'changed in place'
        expect(h.persister.auditNow().mismatches).toBe(1)
        expect(h.mismatches[0]).toMatchObject({ owner: 'character', index: 4 })
    })

    it('runs in idle slices and passes when nothing changed', async () => {
        let idle = false
        const h = harness({ audit: { enabled: true, startDelayMs: 1, retryMs: 5, intervalMs: 0, sliceMs: 0, isIdle: () => idle } })
        const root = h.load(fixtureDisk())
        h.persist(root, 'incremental')
        await new Promise((r) => setTimeout(r, 30))
        expect(h.persister.stats().audit.passes).toBe(0)
        idle = true
        for (let i = 0; i < 100 && h.persister.stats().audit.passes === 0; i++) await new Promise((r) => setTimeout(r, 10))
        expect(h.persister.stats().audit.passes).toBe(1)
        expect(h.persister.stats().audit.mismatches).toBe(0)
        h.persister.stop()
    })
})

describe('planChunks', () => {
    function seeded(n: number, seed: number) {
        const rand = mulberry32(seed)
        const out = Buffer.alloc(n)
        for (let i = 0; i < n; i++) out[i] = rand() < 0.02 ? 0x41 : Math.floor(rand() * 256)
        return out
    }
    for (let seed = 1; seed <= 25; seed++) {
        it(`reproduces cdcSplit of arbitrary edits, seed ${seed}`, () => {
            const rand = mulberry32(seed * 7919)
            const oldBuf = seed % 5 === 0
                ? Buffer.concat([seeded(100_000, seed), Buffer.alloc(200_000, 7), seeded(50_000, seed + 1)])
                : seeded(200_000 + Math.floor(rand() * 600_000), seed)
            const oldChunks = cdcSplit(oldBuf)
            const old = { hashes: oldChunks.map((c: any) => c.hash), lens: oldChunks.map((c: any) => c.data.length) }
            const starts = chunkStarts(old.lens)
            const reader = { readInto: (t: Buffer, to: number, off: number, len: number) => oldBuf.copy(t, to, off, off + len) }
            // Pieces: spans of the old buffer with fresh edits between them.
            const w = createPieceWriter()
            const expected: Buffer[] = []
            let at = 0
            while (at < oldBuf.length) {
                const len = Math.min(oldBuf.length - at, 1 + Math.floor(rand() * 150_000))
                const r = rand()
                if (r < 0.6) { w.span(at, len); expected.push(oldBuf.subarray(at, at + len)) }
                else if (r < 0.8) { const b = seeded(1 + Math.floor(rand() * 3000), seed + at); w.bytes(b); expected.push(b) }
                // else: deleted
                at += len
            }
            if (rand() < 0.5) { const tail = seeded(500, seed); w.bytes(tail); expected.push(tail) }
            if (w.total === 0) return
            const buf = Buffer.concat(expected)
            const plan = planChunks(w, { ...old, starts }, reader)
            const ref = cdcSplit(buf)
            expect(plan.hashes).toEqual(ref.map((c: any) => c.hash))
            expect(plan.lens).toEqual(ref.map((c: any) => c.data.length))
            plan.data.forEach((d: Buffer | null, i: number) => {
                if (d) expect(d.equals(ref[i].data)).toBe(true)
                else expect(old.hashes[plan.reused[i]]).toBe(plan.hashes[i])
            })
        })
    }
})

describe('walkPlan', () => {
    it('accepts exactly a well-formed blob of the planned shape', () => {
        const root = { a: 1, characters: [{ x: 1 }, null], modules: [], personas: [{ y: 'z' }], s: 'x'.repeat(300) }
        const bytes = utils.encodeRisuSaveLegacyBuffer(root)
        const plan = (buf: Buffer, counts: any) => ({
            w: { pieces: [{ fresh: true, buf, start: 0, len: buf.length, at: 0 }], total: buf.length },
            trusted: new Map(),
            counts,
        })
        const counts = { rootKeys: 5, characters: 2, modules: 0, personas: 1 }
        expect(walkPlan(plan(bytes, counts), () => Buffer.alloc(0)).rootKeys).toBe(5)
        expect(() => walkPlan(plan(bytes, { ...counts, characters: 3 }), () => Buffer.alloc(0))).toThrow(/2 characters, expected 3/)
        expect(() => walkPlan(plan(bytes.subarray(0, bytes.length - 1), counts), () => Buffer.alloc(0))).toThrow(/ends at 367, the blob at 366/)
        expect(() => walkPlan(plan(bytes.subarray(0, 40), counts), () => Buffer.alloc(0))).toThrow(/past the end/)
        expect(() => walkPlan(plan(Buffer.concat([bytes, Buffer.from([0xc0])]), counts), () => Buffer.alloc(0))).toThrow(/ends at/)
        const bad = Buffer.from(bytes)
        bad[11] = 0x85
        expect(() => walkPlan(plan(bad, counts), () => Buffer.alloc(0))).toThrow(/not a map16/)
    })
})
