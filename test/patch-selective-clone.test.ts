import { describe, expect, it } from 'vitest'
import selectiveClonePkg from '../server/node/patch-selective-clone.cjs'
import jsonPatchPkg from 'fast-json-patch'

const { clonePatchSnapshot, collectPatchTopLevelKeys, elementIndexesToClone } = selectiveClonePkg as {
    clonePatchSnapshot: (database: any, patch: any[], options?: { shareElements?: boolean }) => any
    collectPatchTopLevelKeys: (patch: any[]) => { keys: Set<string>, touchesRoot: boolean }
    elementIndexesToClone: (key: string, array: unknown[], patch: any[]) => Set<number> | null
}
const { applyPatch } = jsonPatchPkg

function apply(base: any, patch: any[]) {
    const snapshot = clonePatchSnapshot(base, patch)
    applyPatch(snapshot, patch, true)
    return snapshot
}

describe('selective patch snapshot', () => {
    it('clones only the touched top-level branch for a nested replace', () => {
        const untouched = { items: Array.from({ length: 200 }, (_, i) => ({ i, text: `v-${i}` })) }
        const db = { untouched, touched: { nested: { n: 1 } }, other: { ok: true } }
        const patch = [{ op: 'replace', path: '/touched/nested/n', value: 2 }]
        const snapshot = clonePatchSnapshot(db, patch)

        expect(snapshot).not.toBe(db)
        expect(snapshot.touched).not.toBe(db.touched)
        expect(snapshot.untouched).toBe(untouched)
        expect(snapshot.other).toBe(db.other)

        applyPatch(snapshot, patch, true)
        expect(snapshot.touched.nested.n).toBe(2)
        expect(db.touched.nested.n).toBe(1)
    })

    it('keeps top-level add/remove operations isolated with only a shallow root copy', () => {
        const db = { keep: { value: 1 }, removeMe: { value: 2 } }
        const patch = [
            { op: 'remove', path: '/removeMe' },
            { op: 'add', path: '/added', value: { value: 3 } },
        ]
        const snapshot = apply(db, patch)

        expect(snapshot.removeMe).toBeUndefined()
        expect(snapshot.added).toEqual({ value: 3 })
        expect(db.removeMe).toEqual({ value: 2 })
        expect((db as any).added).toBeUndefined()
        expect(snapshot.keep).toBe(db.keep)
    })

    it('clones both source and destination roots for move/copy patches', () => {
        const db = {
            left: { moved: { n: 1 }, copied: { n: 2 } },
            right: { existing: true },
            untouched: { stable: true },
        }
        const patch = [
            { op: 'move', from: '/left/moved', path: '/right/moved' },
            { op: 'copy', from: '/left/copied', path: '/right/copied' },
        ]
        const snapshot = clonePatchSnapshot(db, patch)

        expect(snapshot.left).not.toBe(db.left)
        expect(snapshot.right).not.toBe(db.right)
        expect(snapshot.untouched).toBe(db.untouched)

        applyPatch(snapshot, patch, true)
        expect(snapshot.left.moved).toBeUndefined()
        expect(snapshot.right.moved).toEqual({ n: 1 })
        expect(snapshot.right.copied).toEqual({ n: 2 })
        expect(db.left.moved).toEqual({ n: 1 })
        expect((db.right as any).moved).toBeUndefined()

        // copy must deep-copy: a by-reference copy would alias the destination
        // into the live cache's source branch.
        expect(snapshot.right.copied).not.toBe(db.left.copied)
        snapshot.right.copied.n = 99
        expect(db.left.copied).toEqual({ n: 2 })
        expect(snapshot.left.copied).toEqual({ n: 2 })
    })

    it('preserves the live database when a later patch operation throws', () => {
        const db = { touched: { n: 1 }, untouched: { value: 9 } }
        const before = structuredClone(db)
        const patch = [
            { op: 'replace', path: '/touched/n', value: 2 },
            { op: 'remove', path: '/touched/missing' },
        ]
        const snapshot = clonePatchSnapshot(db, patch)

        expect(() => applyPatch(snapshot, patch, true)).toThrow()
        expect(db).toEqual(before)
    })

    // /api/patch keeps its cached root when applyPatch throws; that is only
    // safe while no failing patch can reach the live branches.
    it('preserves the live database when a failing op follows ops on other branches or the root', () => {
        const db = { characters: [{ name: 'a', chats: [{ id: 'c' }] }], modules: [{ id: 'm' }], other: { n: 1 } }
        const before = structuredClone(db)
        const patches = [
            [
                { op: 'replace', path: '/characters/0/name', value: 'changed' },
                { op: 'add', path: '/characters/0/chats/-', value: { id: 'new' } },
                { op: 'remove', path: '/modules/0' },
                { op: 'replace', path: '/other/missing/deep', value: 1 },
            ],
            [
                { op: 'replace', path: '', value: { replaced: true } },
                { op: 'remove', path: '/characters' },
            ],
            [
                { op: 'move', from: '/characters/0', path: '/modules/0' },
                { op: 'test', path: '/other/n', value: 2 },
            ],
        ]
        for (const patch of patches) {
            expect(() => applyPatch(clonePatchSnapshot(db, patch), patch, true)).toThrow()
            expect(db).toEqual(before)
        }
    })

    it('falls back to a full clone for a document-root operation', () => {
        const db = { a: { n: 1 }, b: { n: 2 } }
        const snapshot = clonePatchSnapshot(db, [{ op: 'replace', path: '', value: { c: 3 } }])

        expect(snapshot).not.toBe(db)
        expect(snapshot.a).not.toBe(db.a)
        expect(snapshot.b).not.toBe(db.b)
    })

    it('falls back to a full clone for an array document root', () => {
        const db = [{ n: 1 }, { n: 2 }]
        const snapshot = clonePatchSnapshot(db, [{ op: 'replace', path: '/0/n', value: 3 }])

        expect(snapshot).not.toBe(db)
        expect(snapshot[0]).not.toBe(db[0])
        expect(snapshot[1]).not.toBe(db[1])
    })

    it('decodes escaped JSON pointer root keys and treats invalid pointers conservatively', () => {
        const decoded = collectPatchTopLevelKeys([
            { op: 'replace', path: '/a~1b/n', value: 2 },
            { op: 'move', from: '/x~0y/n', path: '/plain/n' },
        ])
        expect(decoded.touchesRoot).toBe(false)
        expect([...decoded.keys].sort()).toEqual(['a/b', 'plain', 'x~y'].sort())

        const invalid = collectPatchTopLevelKeys([{ op: 'replace', path: 'not-a-pointer', value: 1 }])
        expect(invalid.touchesRoot).toBe(true)
    })
})

// B2: patches that only change characters[i] / modules[i] in place share
// every other element with the previous root.
describe('element-level patch snapshot', () => {
    function makeDb() {
        return {
            characters: Array.from({ length: 5 }, (_, i) => ({ chaId: `c${i}`, name: `n${i}`, chats: [{ id: `chat${i}`, _stub: true, lastDate: i }] })),
            modules: Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, lorebook: [{ content: 'x' }] })),
            other: { n: 1 },
        }
    }

    it('clones only the elements a nested op changes; every other element is the same object', () => {
        const db = makeDb()
        const before = structuredClone(db)
        const patch = [
            { op: 'replace', path: '/characters/2/chats/0/lastDate', value: 99 },
            { op: 'add', path: '/modules/1/lorebook/-', value: { content: 'y' } },
            { op: 'remove', path: '/characters/4/name' },
        ]
        const snapshot = apply(db, patch)

        expect(snapshot.characters).not.toBe(db.characters)
        expect(snapshot.modules).not.toBe(db.modules)
        expect(snapshot.other).toBe(db.other)
        for (const i of [0, 1, 3]) expect(snapshot.characters[i]).toBe(db.characters[i])
        for (const i of [2, 4]) expect(snapshot.characters[i]).not.toBe(db.characters[i])
        for (const i of [0, 2]) expect(snapshot.modules[i]).toBe(db.modules[i])
        expect(snapshot.modules[1]).not.toBe(db.modules[1])
        expect(snapshot.characters[2].chats[0].lastDate).toBe(99)
        expect(snapshot.modules[1].lorebook).toHaveLength(2)
        expect(snapshot.characters[4].name).toBeUndefined()
        expect(db).toEqual(before)
    })

    it('a depth-2 replace keeps every element and only fills the slot of the array copy', () => {
        const db = makeDb()
        const replacement = { chaId: 'new', name: 'new', chats: [] }
        const patch = [
            { op: 'replace', path: '/characters/1', value: replacement },
            { op: 'replace', path: '/characters/1/name', value: 'edited' },
        ]
        expect(elementIndexesToClone('characters', db.characters, patch)).toEqual(new Set([1]))
        const snapshot = apply(db, patch)
        expect(snapshot.characters[1]).toBe(replacement)
        expect(snapshot.characters[1].name).toBe('edited')
        expect(db.characters[1].name).toBe('n1')
        for (const i of [0, 2, 3, 4]) expect(snapshot.characters[i]).toBe(db.characters[i])
        expect(elementIndexesToClone('characters', db.characters, [{ op: 'replace', path: '/characters/3', value: {} }])).toEqual(new Set())
    })

    it('test ops never clone', () => {
        const db = makeDb()
        const patch = [
            { op: 'test', path: '/characters/0/name', value: 'n0' },
            { op: 'test', path: '/characters/1', value: structuredClone(db.characters[1]) },
        ]
        expect(elementIndexesToClone('characters', db.characters, patch)).toEqual(new Set())
        const snapshot = apply(db, patch)
        snapshot.characters.forEach((c: any, i: number) => expect(c).toBe(db.characters[i]))
    })

    it('falls back to the whole branch for anything that can restructure the array or name an element ambiguously', () => {
        const db = makeDb()
        const wholeBranch = [
            [{ op: 'add', path: '/characters/1', value: {} }],
            [{ op: 'remove', path: '/characters/1' }],
            [{ op: 'add', path: '/characters/-', value: {} }],
            [{ op: 'replace', path: '/characters', value: [] }],
            [{ op: 'test', path: '/characters', value: [] }],
            [{ op: 'move', from: '/characters/0/name', path: '/characters/1/name' }],
            [{ op: 'copy', from: '/characters/0', path: '/other/copied' }],
            [{ op: 'move', from: '/other/n', path: '/characters/0/n' }],
            [{ op: 'replace', from: '/characters/0', path: '/other/n', value: 1 }],
            // fast-json-patch reads '01' as 1, an empty segment as 0 and 4294967296 as 0.
            [{ op: 'replace', path: '/characters/01/name', value: 'x' }],
            [{ op: 'replace', path: '/characters//name', value: 'x' }],
            [{ op: 'replace', path: '/characters/4294967296/name', value: 'x' }],
            [{ op: 'replace', path: '/characters/5/name', value: 'x' }],
            [{ op: 'replace', path: '/characters/-/name', value: 'x' }],
            [{ op: '_get', path: '/characters/0/name' }],
        ]
        for (const patch of wholeBranch) {
            expect(elementIndexesToClone('characters', db.characters, patch), JSON.stringify(patch)).toBeNull()
            const snapshot = clonePatchSnapshot(db, patch)
            expect(snapshot.characters).not.toBe(db.characters)
            snapshot.characters.forEach((c: any, i: number) => expect(c).not.toBe(db.characters[i]))
        }
        // fast-json-patch resolves '01' to element 1 (a test op reads it);
        // with validation on it refuses to write through such a segment, as
        // its existence check uses the raw key. Nothing is trusted either way.
        expect(() => applyPatch(clonePatchSnapshot(db, []), [{ op: 'test', path: '/characters/01/name', value: 'n1' }], true)).not.toThrow()
        expect(() => apply(db, [{ op: 'replace', path: '/characters/01/name', value: 'x' }])).toThrow(/OPERATION_PATH_UNRESOLVABLE/)
        expect(db.characters[1].name).toBe('n1')
    })

    it('shares only characters and modules elements; other arrays are cloned whole', () => {
        const db = { ...makeDb(), personas: [{ name: 'a' }, { name: 'b' }] }
        const snapshot = clonePatchSnapshot(db, [{ op: 'replace', path: '/personas/0/name', value: 'x' }])
        expect(snapshot.personas[1]).not.toBe(db.personas[1])
        expect(snapshot.characters).toBe(db.characters)
    })

    it('shareElements: false clones the whole touched branch, as before B2', () => {
        const db = makeDb()
        const patch = [{ op: 'replace', path: '/characters/2/name', value: 'x' }]
        const snapshot = clonePatchSnapshot(db, patch, { shareElements: false })
        snapshot.characters.forEach((c: any, i: number) => expect(c).not.toBe(db.characters[i]))
        expect(snapshot.modules).toBe(db.modules)
    })

    it('applies to frozen roots, as the server installs them in test mode', () => {
        const db = makeDb()
        const freeze = (v: any): any => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) } return v }
        freeze(db)
        const snapshot = apply(db, [
            { op: 'replace', path: '/characters/3/chats/0/lastDate', value: 7 },
            { op: 'add', path: '/characters/3/chats/-', value: { id: 'new', _stub: true } },
        ])
        expect(snapshot.characters[3].chats).toHaveLength(2)
        expect(snapshot.characters[3].chats[0].lastDate).toBe(7)
        expect(db.characters[3].chats).toHaveLength(1)
        expect(snapshot.characters[0]).toBe(db.characters[0])
    })
})
