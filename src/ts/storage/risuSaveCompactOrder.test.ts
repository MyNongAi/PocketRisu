import { describe, expect, test, vi } from 'vitest'

// Same isolation as risuSavePatcher.test.ts: the patcher is pure once the
// Svelte-bound modules are stubbed out.
vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({ chatToStub: (c: any) => c }))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))

const { RisuSavePatcher, diffKeyedArray, diffCompactRootArray } = await import('./risuSave')
const { applyCharacterOrderCheck } = await import('../characterOrderCheck')
const { DEACTIVATED_FOLDER_IDS, placeReactivatedCharacter } = await import('../deactivatedCharacterFolders')
const { promoteRecentlyViewedCharacter } = await import('../characterRecentOrder')
const { applyPatch, compare } = await import('fast-json-patch')

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 27, 12, 0, 0)
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const bytes = (value: unknown) => JSON.stringify(value).length
const emptyToSave = () => ({
    character: [], chat: [] as [string, string][], root: false, botPreset: false, modules: false, plugins: false, pluginCustomStorage: false,
})

// Deterministic uuid-shaped ids (36 chars, like real chaIds).
function id(n: number): string {
    const hex = n.toString(16).padStart(12, '0')
    return `0000${hex.slice(0, 4)}-1111-4222-8333-${hex}`
}

function applyOps(doc: any, ops: any[]) {
    return applyPatch(clone(doc), clone(ops), true).newDocument
}

describe('diffKeyedArray', () => {
    const keyOf = (value: any) => (typeof value === 'string' ? value : null)
    const none = () => []

    test('one removal is one op, wherever it is', () => {
        const last = Array.from({ length: 1000 }, (_, i) => `x${i}`)
        const cur = last.filter((_, i) => i !== 3)
        expect(diffKeyedArray('/list', last, cur, keyOf, none)).toEqual([{ op: 'remove', path: '/list/3' }])
    })

    test('a move is one remove plus one add', () => {
        const last = ['a', 'b', 'c', 'd', 'e']
        const cur = ['d', 'a', 'b', 'c', 'e']
        const ops = diffKeyedArray('/list', last, cur, keyOf, none)!
        expect(ops).toEqual([{ op: 'remove', path: '/list/3' }, { op: 'add', path: '/list/0', value: 'd' }])
        expect(applyOps({ list: last }, ops).list).toEqual(cur)
    })

    test('returns null for duplicated or missing keys', () => {
        expect(diffKeyedArray('/l', ['a', 'a'], ['a'], keyOf, none)).toBeNull()
        expect(diffKeyedArray('/l', ['a'], ['a', 3], keyOf, none)).toBeNull()
    })

    test('round-trips random edits exactly', () => {
        let seed = 7
        const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
        for (let round = 0; round < 200; round++) {
            const last = Array.from({ length: 30 }, (_, i) => `k${i}`).filter(() => random() > 0.2)
            const cur = last.filter(() => random() > 0.2)
            for (let i = 0; i < 5; i++) cur.splice(Math.floor(random() * (cur.length + 1)), 0, `n${round}-${i}`)
            for (let i = cur.length - 1; i > 0; i--) {
                if (random() < 0.1) {
                    const j = Math.floor(random() * (i + 1))
                    ;[cur[i], cur[j]] = [cur[j], cur[i]]
                }
            }
            const ops = diffKeyedArray('/list', last, cur, keyOf, none)!
            expect(applyOps({ list: last }, ops).list).toEqual(cur)
        }
    })
})

describe('diffCompactRootArray', () => {
    test('diffs a changed folder in place and falls back to a single replace when that is smaller', () => {
        const last = ['a', { id: 'f', name: 'F', color: '', data: ['b', 'c'] }]
        const cur = ['a', { id: 'f', name: 'G', color: '', data: ['c', 'b', 'd'] }]
        const ops = diffCompactRootArray(compare, 'characterOrder', last, cur)!
        expect(applyOps({ characterOrder: last }, ops).characterOrder).toEqual(cur)
        expect(bytes(ops)).toBeLessThanOrEqual(bytes([{ op: 'replace', path: '/characterOrder', value: cur }]))

        const tiny = diffCompactRootArray(compare, 'characterOrder', ['a'], ['b', 'c'])!
        expect(tiny).toEqual([{ op: 'replace', path: '/characterOrder', value: ['b', 'c'] }])
    })

    test('is only used for the listed keys and for arrays', () => {
        expect(diffCompactRootArray(compare, 'personas', [], [])).toBeNull()
        expect(diffCompactRootArray(compare, 'characterOrder', undefined, [])).toBeNull()
    })

    test('duplicate ids fall back to a correct (possibly larger) diff', () => {
        const last = ['a', 'a', 'b']
        const cur = ['a', 'b']
        const ops = diffCompactRootArray(compare, 'characterOrder', last, cur)!
        expect(applyOps({ characterOrder: last }, ops).characterOrder).toEqual(cur)
    })
})

describe('patch size on a 1,300-card catalog with idle-age folders', () => {
    // 1,000 active cards and 300 deactivated ones: 20 user folders of 10
    // active cards (three of them also hold two deactivated cards each), a
    // folder with one active card and four deactivated ones, two fully
    // deactivated folders of five, and 280 loose deactivated cards that the
    // check files into the age folders.
    function catalog() {
        const characters = Array.from({ length: 1000 }, (_, i) => ({
            chaId: id(i), name: `Card ${i}`, desc: 'lore '.repeat(40), firstMessage: '', chatPage: 0,
            chats: [{ id: `chat-${i}`, name: 'c', _stub: true }], lastInteraction: NOW - (i % 90) * DAY,
        }))
        const stubs = Array.from({ length: 300 }, (_, i) => ({
            chaId: id(5000 + i), name: `Old ${i}`, image: `assets/${id(9000 + i)}.png`, tags: [],
            lastInteraction: NOW - (i % 120) * DAY + 3600_000, archivedAt: NOW - DAY, bytes: 12345,
            chatCount: 1, chatIds: [`old-chat-${i}`], assetCount: 3, autoDeactivatedAt: NOW - DAY,
        }))
        const stubIds = stubs.map((s) => s.chaId)
        const folders: any[] = Array.from({ length: 20 }, (_, f) => ({
            id: id(20000 + f), name: `Folder ${f}`, color: '',
            data: [...characters.slice(f * 10, f * 10 + 10).map((c) => c.chaId), ...(f < 3 ? stubIds.slice(f * 2, f * 2 + 2) : [])],
        }))
        folders.push({ id: id(30000), name: 'Almost', color: 'green', data: [characters[200].chaId, ...stubIds.slice(6, 10)] })
        folders.push({ id: id(30001), name: 'Old box A', color: 'red', data: stubIds.slice(10, 15) })
        folders.push({ id: id(30002), name: 'Old box B', color: 'blue', data: stubIds.slice(15, 20) })
        const order: any[] = [...folders, ...characters.slice(201).map((c) => c.chaId), ...stubIds.slice(20)]
        const db: any = {
            formatversion: 4, username: 'u', botPresets: [], modules: [],
            characters, characterOrder: order, nodeOnlyArchivedCharacters: stubs,
        }
        applyCharacterOrderCheck(db, { now: NOW })
        return db
    }

    // What archiveCharacter / archiveCharacters do to the database: the
    // characters leave `characters` (descending), the stubs join the list,
    // then one checkCharOrder.
    function deactivate(db: any, chaIds: string[], now = NOW) {
        for (const chaId of chaIds) {
            const character = db.characters.find((c: any) => c.chaId === chaId)
            db.nodeOnlyArchivedCharacters.push({
                chaId, name: character.name, image: '', tags: [], lastInteraction: character.lastInteraction,
                archivedAt: now, bytes: 999, chatCount: 1, chatIds: [character.chats[0].id], autoDeactivatedAt: now,
            })
        }
        const moved = new Set(chaIds)
        for (let i = db.characters.length - 1; i >= 0; i--) {
            if (moved.has(db.characters[i].chaId)) db.characters.splice(i, 1)
        }
        applyCharacterOrderCheck(db, { now })
    }

    // What activateCharacter does: the card returns, placement + promotion, then the check.
    function reactivate(db: any, chaId: string) {
        db.nodeOnlyArchivedCharacters = db.nodeOnlyArchivedCharacters.filter((s: any) => s.chaId !== chaId)
        db.characters.push({ chaId, name: 'back', desc: '', firstMessage: '', chatPage: 0, chats: [], lastInteraction: NOW })
        db.characterOrder = promoteRecentlyViewedCharacter(placeReactivatedCharacter(db.characterOrder, chaId), chaId)
        applyCharacterOrderCheck(db, { now: NOW })
    }

    function opsUnder(patch: any[], root: string) {
        return patch.filter((op) => op.path === `/${root}` || op.path.startsWith(`/${root}/`))
    }

    async function measure(label: string, db: any, change: (next: any) => void) {
        const patcher = new RisuSavePatcher()
        await patcher.init(clone(db))
        const next = clone(db)
        change(next)
        const { patch } = await patcher.set(clone(next), emptyToSave())
        // The patched server copy hashes like a fresh load of the client's state.
        const fresh = new RisuSavePatcher()
        await fresh.init(clone(next))
        expect(patcher.hash()).toBe(fresh.hash())
        expect(applyOps(db, patch)).toEqual(next)
        const orderOps = opsUnder(patch, 'characterOrder')
        const generic = bytes(compare({ characterOrder: db.characterOrder }, { characterOrder: next.characterOrder }))
        console.info(`[patch-size] ${label}: characterOrder ${orderOps.length} ops / ${bytes(orderOps)} B (generic diff ${generic} B), `
            + `stubs ${bytes(opsUnder(patch, 'nodeOnlyArchivedCharacters'))} B, whole patch ${patch.length} ops / ${bytes(patch)} B`)
        return { patch, next, orderOps }
    }

    test('the catalog has 1,300 cards, the zone and the age folders at the end', () => {
        const db = catalog()
        const all = new Set<string>()
        for (const entry of db.characterOrder) {
            if (typeof entry === 'string') all.add(entry)
            else for (const member of entry.data) all.add(member)
        }
        expect(all.size).toBe(1300)
        const tail = db.characterOrder.slice(-6).map((entry: any) => entry.id ?? entry)
        expect(tail).toEqual([id(30001), id(30002), ...[7, 15, 30, 60].map((days) => DEACTIVATED_FOLDER_IDS[days as 7])])
    })

    test('deactivating a loose card sends a few small ops, never the whole catalog', async () => {
        const db = catalog()
        const { patch, orderOps } = await measure('deactivate a loose card', db, (next) => deactivate(next, [id(205)]))
        expect(patch.some((op) => op.path === '/characters')).toBe(false)
        expect(opsUnder(patch, 'characters')).toEqual([{ op: 'remove', path: expect.stringMatching(/^\/characters\/\d+$/) }])
        expect(orderOps.length).toBeLessThanOrEqual(3)
        expect(bytes(orderOps)).toBeLessThan(1000)
        expect(bytes(opsUnder(patch, 'nodeOnlyArchivedCharacters'))).toBeLessThan(1000)
        expect(bytes(patch)).toBeLessThan(3000)
    })

    test('deactivating a card inside a user folder leaves the order untouched', async () => {
        const db = catalog()
        const { orderOps } = await measure('deactivate a card in a user folder', db, (next) => deactivate(next, [id(13)]))
        expect(orderOps).toEqual([])
    })

    test('a folder that becomes fully deactivated moves into the zone with one remove and one add', async () => {
        const db = catalog()
        const { orderOps } = await measure('folder moves into the zone', db, (next) => deactivate(next, [id(200)]))
        expect(orderOps.map((op) => op.op)).toEqual(['remove', 'add'])
        expect(bytes(orderOps)).toBeLessThan(1000)
    })

    test('bulk deactivation of a 20-card chunk sends per-index removes and a bounded order diff', async () => {
        const db = catalog()
        const chunk = Array.from({ length: 20 }, (_, i) => id(300 + i * 7))
        const { patch, orderOps } = await measure('bulk deactivate 20 loose cards', db, (next) => deactivate(next, chunk))
        expect(patch.some((op) => op.path === '/characters')).toBe(false)
        expect(opsUnder(patch, 'characters')).toHaveLength(20)
        expect(opsUnder(patch, 'characters').every((op) => op.op === 'remove')).toBe(true)
        expect(bytes(orderOps)).toBeLessThan(20 * 150 + 500)
        expect(bytes(patch)).toBeLessThan(20 * 600 + 1000)
    })

    test('the hourly re-bucketing that moves a few ids stays small', async () => {
        const db = catalog()
        const { patch } = await measure('hourly re-bucket', db, (next) => {
            expect(applyCharacterOrderCheck(next, { now: NOW + 2 * 3600_000 })).toBe(true)
        })
        const moved = patch.filter((op) => op.op === 'add').length
        expect(moved).toBeGreaterThan(0)
        expect(patch.every((op) => op.path.startsWith('/characterOrder/'))).toBe(true)
        expect(bytes(patch)).toBeLessThan(200 * moved + 200)
    })

    test('a run that changes nothing produces no ops', async () => {
        const db = catalog()
        const { patch } = await measure('no-op check', db, (next) => {
            expect(applyCharacterOrderCheck(next, { now: NOW })).toBe(false)
        })
        expect(patch).toEqual([])
    })

    test('reactivating a stub from the middle of the list does not re-diff every later stub', async () => {
        const db = catalog()
        const target = db.nodeOnlyArchivedCharacters[140].chaId
        const { patch, orderOps } = await measure('reactivate a loose card', db, (next) => reactivate(next, target))
        expect(opsUnder(patch, 'nodeOnlyArchivedCharacters')).toEqual([{ op: 'remove', path: '/nodeOnlyArchivedCharacters/140' }])
        expect(bytes(orderOps)).toBeLessThan(1000)
    })

    test('reactivating a card of a zone folder lifts the folder with one remove and one add', async () => {
        const db = catalog()
        const { orderOps, next } = await measure('reactivate a zone-folder card', db, (n) => reactivate(n, id(5010)))
        expect(next.characterOrder[0].id).toBe(id(30001))
        expect(orderOps.map((op) => op.op)).toEqual(['remove', 'add'])
        expect(bytes(orderOps)).toBeLessThan(1000)
    })
})
