import { describe, expect, it, vi } from 'vitest'
import { applyOperation, applyPatch } from 'fast-json-patch'

// The real patcher writes the ops; only the heavy app modules are mocked.
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))
vi.mock('../storage/database.svelte', async () => {
    const { isChatStub } = await import('../storage/chatStub')
    return { isChatStub, createBotPresetTemplate: () => ({}), getDatabase: () => ({}) }
})

const { RisuSavePatcher, findDangerousChatOps } = await import('../storage/risuSave')
const { RemoteOpRejected, applyOpsCopyOnWrite, checkRemoteOps } = await import('./copyOnWritePatch')

const ALL = { character: [], chat: [], root: true, botPreset: true, modules: true, moduleIds: null, plugins: false, pluginCustomStorage: false }

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value)
        for (const child of Object.values(value)) deepFreeze(child)
    }
    return value
}

/** A server view: chats as catalog stubs. */
function serverDb(): any {
    return {
        username: 'me',
        personaPrompt: 'hi',
        statics: { messages: 10, imports: 0 },
        // Long enough that the keyed diff beats one whole-array replace.
        characterOrder: Array.from({ length: 40 }, (_, i) => `character-${i}`),
        nested: { a: { b: { c: { d: 1, e: [1, 2, 3] } } }, other: { x: 1 } },
        pluginCustomStorage: {},
        characters: [
            {
                chaId: 'c1', name: 'Alice', chatPage: 0, desc: 'd1',
                chats: [
                    { id: 'a1', name: 'Chat 1', lastDate: 1, _stub: true },
                    { id: 'a2', name: 'Chat 2', lastDate: 2, _stub: true },
                ],
            },
            { chaId: 'c2', name: 'Bob', chatPage: 0, desc: 'd2', chats: [{ id: 'b1', name: 'B', lastDate: 3, _stub: true }] },
            { chaId: 'c3', name: 'Cid', chatPage: 0, desc: 'd3', chats: [] },
        ],
        botPresets: [{ id: 'p1', name: 'Preset' }],
        modules: [{ id: 'm1', name: 'Mod 1', lorebook: [] }, { id: 'm2', name: 'Mod 2', lorebook: [] }],
    }
}

/** The copy-on-write result, checked against a plain apply on a deep copy (I14). */
function applyBoth(base: any, ops: any[]) {
    const before = JSON.stringify(base)
    const frozen = deepFreeze(base)
    const result = applyOpsCopyOnWrite(frozen, structuredClone(ops), applyOperation)
    const reference = applyPatch(structuredClone(base), structuredClone(ops), true).newDocument
    expect(result).toEqual(reference)
    expect(JSON.stringify(base)).toBe(before)
    return result
}

/** The ops a page's real patcher sends for an edit of the server view. */
async function patcherOps(edit: (db: any) => void) {
    const patcher = new RisuSavePatcher()
    await patcher.init(serverDb())
    const live = serverDb()
    edit(live)
    const { patch } = await patcher.fork().set(live, ALL)
    return patch
}

describe('applyOpsCopyOnWrite', () => {
    it('applies add, replace and remove at depths 1 to 5', () => {
        const base = serverDb()
        const ops = [
            { op: 'replace', path: '/username', value: 'you' },
            { op: 'add', path: '/added', value: { k: 1 } },
            { op: 'replace', path: '/nested/other', value: { x: 2 } },
            { op: 'add', path: '/nested/a/b2', value: 1 },
            { op: 'replace', path: '/nested/a/b/c/d', value: 2 },
            { op: 'remove', path: '/nested/a/b/c/e/0' },
            { op: 'add', path: '/added/k2', value: [1] },
        ]
        const result = applyBoth(base, ops)
        expect(result.added).toEqual({ k: 1, k2: [1] })
        // Untouched subtrees are the baseline's own objects.
        expect(result.characters).toBe(base.characters)
        expect(result.modules).toBe(base.modules)
        expect(result.statics).toBe(base.statics)
        expect(result.nested).not.toBe(base.nested)
        expect(result.nested.a.b.c).not.toBe(base.nested.a.b.c)
    })

    it('copies only the path of a deep chat catalog edit', () => {
        const base = serverDb()
        const result = applyBoth(base, [{ op: 'replace', path: '/characters/0/chats/1/name', value: 'Renamed' }])
        expect(result.characters).not.toBe(base.characters)
        expect(result.characters[0]).not.toBe(base.characters[0])
        expect(result.characters[0].chats[0]).toBe(base.characters[0].chats[0])
        expect(result.characters[1]).toBe(base.characters[1])
        expect(result.characters[2]).toBe(base.characters[2])
        expect(result.characters[0].chats[1].name).toBe('Renamed')
    })

    it('appends with /characters/- and edits the new entry without copying it', () => {
        const base = serverDb()
        const result = applyBoth(base, [
            { op: 'add', path: '/characters/-', value: { chaId: 'c4', name: 'New', chats: [] } },
            { op: 'replace', path: '/characters/3/name', value: 'Newer' },
        ])
        expect(result.characters.map((c: any) => c.chaId)).toEqual(['c1', 'c2', 'c3', 'c4'])
        expect(result.characters[0]).toBe(base.characters[0])
        expect(result.characters[3].name).toBe('Newer')
    })

    it('writes into the element an earlier op shifted to that index', () => {
        const base = serverDb()
        const result = applyBoth(base, [
            { op: 'remove', path: '/characters/0' },
            { op: 'replace', path: '/characters/0/desc', value: 'bob edited' },
        ])
        expect(result.characters.map((c: any) => c.chaId)).toEqual(['c2', 'c3'])
        expect(result.characters[0].desc).toBe('bob edited')
        expect(result.characters[1]).toBe(base.characters[2])
        expect(base.characters[1].desc).toBe('d2')
    })

    it('lands the keyed characterOrder diff the patcher sends', async () => {
        const moved = 'character-27'
        const ops = await patcherOps((db) => { db.characterOrder = [moved, ...db.characterOrder.filter((id: string) => id !== moved)] })
        expect(ops.length).toBeGreaterThan(0)
        expect(ops.every((op: any) => op.path.startsWith('/characterOrder/'))).toBe(true)
        const result = applyBoth(serverDb(), ops)
        expect(result.characterOrder[0]).toBe(moved)
        expect(result.characterOrder).toHaveLength(40)
    })

    it('lands the patcher\'s add/remove ops for characters and modules', async () => {
        const ops = await patcherOps((db) => {
            db.characters.splice(1, 1)
            db.characters.push({ chaId: 'c9', name: 'Imported', chatPage: 0, chats: [{ id: 'z1', name: 'Z', _stub: true }] })
            db.modules.splice(0, 1)
            db.modules.push({ id: 'm3', name: 'Mod 3', lorebook: [] })
        })
        expect(ops.some((op: any) => op.path === '/characters')).toBe(false)
        expect(ops.some((op: any) => op.path === '/modules')).toBe(false)
        const base = serverDb()
        const result = applyBoth(base, ops)
        expect(result.characters.map((c: any) => c.chaId)).toEqual(['c1', 'c3', 'c9'])
        expect(result.modules.map((m: any) => m.id)).toEqual(['m2', 'm3'])
        expect(result.characters[0]).toBe(base.characters[0])
        expect(result.modules[0]).toBe(base.modules[1])
    })

    it('lands a whole /characters replace (a reorder)', async () => {
        const ops = await patcherOps((db) => { db.characters.reverse() })
        expect(ops).toEqual([expect.objectContaining({ op: 'replace', path: '/characters' })])
        const result = applyBoth(serverDb(), ops)
        expect(result.characters.map((c: any) => c.chaId)).toEqual(['c3', 'c2', 'c1'])
    })

    it('runs on a deep-frozen baseline without throwing', () => {
        const base = deepFreeze(serverDb())
        expect(() => applyOpsCopyOnWrite(base, [
            { op: 'replace', path: '/characters/1/chats/0/name', value: 'x' },
            { op: 'remove', path: '/modules/1' },
            { op: 'add', path: '/nested/a/b/c/e/-', value: 4 },
        ], applyOperation)).not.toThrow()
    })

    it('rejects an op that does not apply, leaving the baseline as it was', () => {
        const base = serverDb()
        const before = JSON.stringify(base)
        const cases: [any, string][] = [
            [{ op: 'replace', path: '/missing/x', value: 1 }, 'missing-parent'],
            [{ op: 'replace', path: '/characters/7/name', value: 1 }, 'missing-parent'],
            [{ op: 'replace', path: '/characters/01/name', value: 1 }, 'missing-parent'],
            [{ op: 'replace', path: '/username/x', value: 1 }, 'missing-parent'],
            [{ op: 'replace', path: '/characters/01', value: 1 }, 'bad-index'],
            [{ op: 'replace', path: '/characters/-', value: 1 }, 'bad-index'],
            [{ op: 'replace', path: '/nope', value: 1 }, 'apply'],
            [{ op: 'remove', path: '/characters/3' }, 'apply'],
            [{ op: 'add', path: '/characters/9', value: {} }, 'apply'],
            [{ op: 'add', path: '/x' }, 'apply'],
        ]
        for (const [op, reason] of cases) {
            let caught: unknown
            try {
                applyOpsCopyOnWrite(deepFreeze(base), [{ op: 'replace', path: '/characters/0/name', value: 'first' }, op], applyOperation)
            } catch (error) { caught = error }
            expect(caught, JSON.stringify(op)).toBeInstanceOf(RemoteOpRejected)
            expect((caught as InstanceType<typeof RemoteOpRejected>).reason, JSON.stringify(op)).toBe(reason)
            expect((caught as InstanceType<typeof RemoteOpRejected>).index).toBe(1)
        }
        expect(JSON.stringify(base)).toBe(before)
    })
})

describe('checkRemoteOps', () => {
    const reasonOf = (ops: unknown) => {
        try {
            checkRemoteOps(ops, findDangerousChatOps)
        } catch (error) {
            if (error instanceof RemoteOpRejected) return error.reason
            throw error
        }
        return null
    }

    it('accepts the ops the patcher writes', async () => {
        const ops = await patcherOps((db) => {
            db.username = 'you'
            db.characters[0].chats[1].name = 'Renamed'
            db.characters[1].desc = 'x'
        })
        expect(ops.length).toBeGreaterThan(0)
        expect(reasonOf(ops)).toBeNull()
        expect(reasonOf([])).toBeNull()
    })

    it('rejects every shape the landing does not take', () => {
        const cases: [unknown, string][] = [
            [{ op: 'add', path: '/x', value: 1 }, 'not-array'],
            [[null], 'op-shape'],
            [[[]], 'op-shape'],
            [['add'], 'op-shape'],
            [[new (class Op { op = 'add'; path = '/x'; value = 1 })()], 'op-shape'],
            [[{ op: 'move', from: '/a', path: '/b' }], 'op-type'],
            [[{ op: 'copy', from: '/a', path: '/b' }], 'op-type'],
            [[{ op: 'test', path: '/a', value: 1 }], 'op-type'],
            [[{ op: '_get', path: '/a' }], 'op-type'],
            [[{ op: 'replace', from: '/a', path: '/b', value: 1 }], 'from'],
            [[{ op: 'replace', path: '', value: {} }], 'path'],
            [[{ op: 'replace', path: 'username', value: 1 }], 'path'],
            [[{ op: 'replace', path: 7, value: 1 }], 'path'],
            [[{ op: 'replace', path: '/', value: 1 }], 'empty-segment'],
            [[{ op: 'add', path: '/__proto__/polluted', value: 1 }], 'proto-segment'],
            [[{ op: 'add', path: '/nested/constructor/prototype/polluted', value: 1 }], 'proto-segment'],
            [[{ op: 'add', path: '/x/_~1_~0/__proto__', value: 1 }], 'proto-segment'],
            [[{ op: 'add', path: '/pluginCustomStorage/k', value: 1 }], 'plugin-storage'],
            [[{ op: 'replace', path: '/pluginCustomStorage', value: {} }], 'plugin-storage'],
            [[{ op: 'add', path: '/characters/0/chats/0/message', value: [] }], 'chat-field'],
            [[{ op: 'remove', path: '/characters/0/chats/0/_stub' }], 'chat-field'],
        ]
        for (const [ops, reason] of cases) expect(reasonOf(ops), JSON.stringify(ops)).toBe(reason)
    })

    it('decodes ~1 and ~0 before checking a segment', () => {
        expect(reasonOf([{ op: 'add', path: '/a~1b/~0', value: 1 }])).toBeNull()
        expect(reasonOf([{ op: 'add', path: '/x/__proto~0__', value: 1 }])).toBeNull()
    })
})
