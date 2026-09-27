import { describe, expect, it } from 'vitest'
import patchHashPkg from '../server/node/patch-hash-cache.cjs'
import utilsPkg from '../server/node/utils.cjs'
import jsonPatchPkg from 'fast-json-patch'
import selectiveClonePkg from '../server/node/patch-selective-clone.cjs'

const { createPatchHashCache, collectTouchedTopLevelKeys } = patchHashPkg as {
    createPatchHashCache: (calculateHash: (value: any) => number) => {
        hash: (database: any) => number
        update: (previousDatabase: any, nextDatabase: any, patch: any[]) => number
        keyHashes: (database: any) => Record<string, number>
        elementHash: (value: any) => number
        reset: () => void
    }
    collectTouchedTopLevelKeys: (patch: any[]) => { keys: Set<string>, touchesRoot: boolean }
}
const { calculateHash } = utilsPkg as { calculateHash: (value: any) => number }
const { applyPatch } = jsonPatchPkg
const { clonePatchSnapshot } = selectiveClonePkg as { clonePatchSnapshot: (database: any, patch: any[]) => any }

function apply(base: any, patch: any[]) {
    const next = structuredClone(base)
    applyPatch(next, patch, true)
    return next
}

describe('patch hash cache', () => {
    it('matches calculateHash on initial object state', () => {
        const db = {
            username: 'u',
            modules: [{ id: 'm1', value: 1 }],
            pluginCustomStorage: { alpha: { nested: { n: 1 } } },
            characters: [{ chaId: 'c1', chats: [{ id: 'chat', _stub: true }] }],
        }
        const cache = createPatchHashCache(calculateHash)
        expect(cache.hash(db)).toBe(calculateHash(db))
    })

    it('matches reference after nested replace and add/remove top-level operations', () => {
        const cache = createPatchHashCache(calculateHash)
        let db: any = {
            username: 'u',
            pluginCustomStorage: { alpha: { n: 1 }, beta: { n: 2 } },
            modules: [{ id: 'm1', value: 1 }],
        }
        expect(cache.hash(db)).toBe(calculateHash(db))

        const patches = [
            [{ op: 'replace', path: '/pluginCustomStorage/alpha/n', value: 7 }],
            [{ op: 'add', path: '/newRoot', value: { ok: true } }],
            [{ op: 'remove', path: '/modules' }],
        ]

        for (const patch of patches) {
            const next = apply(db, patch)
            expect(cache.update(db, next, patch)).toBe(calculateHash(next))
            expect(cache.hash(next)).toBe(calculateHash(next))
            db = next
        }
    })

    it('tracks both path and from for cross-root move/copy operations', () => {
        const cache = createPatchHashCache(calculateHash)
        let db: any = {
            left: { a: { value: 1 } },
            right: { b: { value: 2 } },
        }
        expect(cache.hash(db)).toBe(calculateHash(db))

        const movePatch = [{ op: 'move', from: '/left/a', path: '/right/a' }]
        let next = apply(db, movePatch)
        expect(cache.update(db, next, movePatch)).toBe(calculateHash(next))
        db = next

        const copyPatch = [{ op: 'copy', from: '/right/a', path: '/left/copied' }]
        next = apply(db, copyPatch)
        expect(cache.update(db, next, copyPatch)).toBe(calculateHash(next))
    })

    it('decodes escaped JSON pointer top-level keys', () => {
        const { keys, touchesRoot } = collectTouchedTopLevelKeys([
            { op: 'replace', path: '/a~1b/value', value: 2 },
            { op: 'copy', from: '/x~0y/value', path: '/plain/value' },
        ])
        expect(touchesRoot).toBe(false)
        expect([...keys].sort()).toEqual(['a/b', 'plain', 'x~y'].sort())
    })

    it('falls back to a full rebuild when the document root is touched', () => {
        const cache = createPatchHashCache(calculateHash)
        const db = { a: { n: 1 }, b: { n: 2 } }
        expect(cache.hash(db)).toBe(calculateHash(db))
        const next = { replacement: { ok: true } }
        expect(cache.update(db, next, [{ op: 'replace', path: '', value: next }])).toBe(calculateHash(next))
    })

    it('does not rehash an untouched large top-level value on a later patch', () => {
        const largeUntouched = { items: Array.from({ length: 200 }, (_, i) => ({ i, text: `v-${i}` })) }
        const db = { largeUntouched, touched: { n: 1 }, other: 'x' }
        let largeHashCalls = 0
        const countingHash = (value: any) => {
            if (value === largeUntouched) largeHashCalls++
            return calculateHash(value)
        }
        const cache = createPatchHashCache(countingHash)
        expect(cache.hash(db)).toBe(calculateHash(db))
        expect(largeHashCalls).toBe(1)

        const patch = [{ op: 'replace', path: '/touched/n', value: 2 }]
        const next = apply(db, patch)
        expect(cache.update(db, next, patch)).toBe(calculateHash(next))
        expect(largeHashCalls).toBe(1)
    })
})

describe('patch hash cache — keyHashes', () => {
    it('exposes per-root-key hashes equal to calculateHash of each value, before and after an update', () => {
        const db = {
            username: 'u',
            modules: [{ id: 'm1', value: 1 }],
            characters: [{ chaId: 'c1', chats: [{ id: 'chat', _stub: true }] }],
        }
        const cache = createPatchHashCache(calculateHash)
        cache.hash(db)
        expect(cache.keyHashes(db)).toEqual({
            username: calculateHash(db.username),
            modules: calculateHash(db.modules),
            characters: calculateHash(db.characters),
        })

        const patch = [{ op: 'replace', path: '/modules/0/value', value: 2 }]
        const next = apply(db, patch)
        cache.update(db, next, patch)
        const hashes = cache.keyHashes(next)
        expect(hashes.modules).toBe(calculateHash(next.modules))
        expect(hashes.username).toBe(calculateHash(db.username))
        expect(hashes.characters).toBe(calculateHash(db.characters))
    })

    it('fills keys the cache has not seen and returns nothing for a non-object root', () => {
        const cache = createPatchHashCache(calculateHash)
        const db: any = { a: 1 }
        cache.hash(db)
        db.b = 'late'
        expect(cache.keyHashes(db)).toEqual({ a: calculateHash(1), b: calculateHash('late') })
        expect(cache.keyHashes([1, 2])).toEqual({})
    })
})

// B2: arrays at the root are hashed as calculateHash's own fold over per-
// element hashes memoized on the element objects, so a root that shares its
// untouched characters/modules with the previous one rehashes only the rest.
describe('patch hash cache — element hash memo', () => {
    it('hashes root arrays of any shape exactly like calculateHash', () => {
        const cache = createPatchHashCache(calculateHash)
        const shared = { same: 'object twice' }
        const db = {
            objects: [{ a: 1 }, { b: [1, 2, { c: null }] }, shared, shared],
            primitives: ['x', 1, 2.5, -3, true, false, null, '가나다'],
            nested: [[1, [2]], [], [{}], [[]]],
            empty: [],
            mixed: [{ a: 1 }, 'str', 7, null, [3]],
            scalar: 'root string',
        }
        expect(cache.hash(db)).toBe(calculateHash(db))
        const keyHashes = cache.keyHashes(db)
        for (const [key, value] of Object.entries(db)) expect(keyHashes[key]).toBe(calculateHash(value))
        for (const element of db.objects) expect(cache.elementHash(element)).toBe(calculateHash(element))
        expect(cache.elementHash('primitive')).toBe(calculateHash('primitive'))
    })

    it('rehashes only the cloned element after an element-level patch', () => {
        const characters = Array.from({ length: 50 }, (_, i) => ({ chaId: `c${i}`, chats: [{ id: `chat${i}`, lastDate: i }] }))
        const elements = new Set<unknown>(characters)
        let elementCalls = 0
        const counting = (value: any) => {
            if (elements.has(value)) elementCalls++
            return calculateHash(value)
        }
        const cache = createPatchHashCache(counting)
        const db = { characters, username: 'u' }
        expect(cache.hash(db)).toBe(calculateHash(db))
        expect(elementCalls).toBe(50)

        const patch = [{ op: 'replace', path: '/characters/7/chats/0/lastDate', value: 99 }]
        const next = clonePatchSnapshot(db, patch)
        applyPatch(next, patch, true)
        expect(next.characters[6]).toBe(characters[6])
        elements.add(next.characters[7])
        elementCalls = 0
        expect(cache.update(db, next, patch)).toBe(calculateHash(next))
        expect(elementCalls).toBe(1)
        expect(cache.hash(next)).toBe(calculateHash(next))
        expect(elementCalls).toBe(1)
    })

    it('reset forgets every root and element hash', () => {
        const characters = [{ chaId: 'a' }, { chaId: 'b' }]
        let calls = 0
        const cache = createPatchHashCache((value: any) => {
            if (characters.includes(value)) calls++
            return calculateHash(value)
        })
        const db = { characters }
        cache.hash(db)
        cache.hash(db)
        expect(calls).toBe(2)
        cache.reset()
        expect(cache.hash(db)).toBe(calculateHash(db))
        expect(calls).toBe(4)
    })
})
