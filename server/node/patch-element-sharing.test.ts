// B2 fuzz: element-level patch snapshots (patch-selective-clone.cjs) and the
// element hash memo (patch-hash-cache.cjs) against the pre-B2 clone path.
//
// Every patch is applied twice to the same previous root: once the way
// /api/patch does now, once through a verbatim copy of the old
// clonePatchSnapshot (every touched top-level branch cloned whole). Checked
// after each patch:
//  - both paths fail, or both succeed with byte-identical roots;
//  - the cached hash equals calculateHash (the protocol hash) of the result;
//  - the previous root encodes to the same bytes as before;
//  - in a non-structural patch, every characters[i] / modules[i] no op
//    changes is the previous root's own object.
// It runs once with roots deep-frozen as the server installs them under
// POCKETRISU_TEST_FREEZE_CACHE, and once unfrozen, where a missed clone would
// really write into the previous root and fail the bytes check.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const requireCjs = createRequire(import.meta.url)
const { clonePatchSnapshot } = requireCjs('./patch-selective-clone.cjs')
const { createPatchHashCache } = requireCjs('./patch-hash-cache.cjs')
const { calculateHash, encodeRisuSaveLegacyBuffer } = requireCjs('./utils.cjs')
const { deepFreeze } = requireCjs('./chat-body-store.cjs')
// The same fast-json-patch build server.cjs requires.
const { applyPatch } = requireCjs('fast-json-patch')

type Op = { op: string, path: string, from?: string, value?: unknown }
type Root = Record<string, any>

// ---- verbatim copy of patch-selective-clone.cjs at 091c4af9a (pre-B2) ----
function legacyDecodePointerSegment(segment: string) {
    return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}
function legacyCollectPatchTopLevelKeys(patch: any) {
    const keys = new Set<string>()
    let touchesRoot = false
    for (const op of Array.isArray(patch) ? patch : []) {
        for (const field of ['path', 'from']) {
            const pointer = op?.[field]
            if (typeof pointer !== 'string') continue
            if (pointer === '') { touchesRoot = true; continue }
            if (!pointer.startsWith('/')) { touchesRoot = true; continue }
            const nextSlash = pointer.indexOf('/', 1)
            const rawSegment = nextSlash === -1 ? pointer.slice(1) : pointer.slice(1, nextSlash)
            keys.add(legacyDecodePointerSegment(rawSegment))
        }
    }
    return { keys, touchesRoot }
}
function legacyClonePatchSnapshot(database: any, patch: any) {
    if (!(database !== null && typeof database === 'object' && !Array.isArray(database))) return structuredClone(database)
    const { keys, touchesRoot } = legacyCollectPatchTopLevelKeys(patch)
    if (touchesRoot) return structuredClone(database)
    const snapshot = { ...database }
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(database, key)) {
            Object.defineProperty(snapshot, key, { value: structuredClone(database[key]), enumerable: true, configurable: true, writable: true })
        }
    }
    return snapshot
}
// ---- end of the copy ----

function mulberry32(seed: number) {
    return () => {
        seed |= 0
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

let serial = 0
function makeStub(rand: () => number) {
    const id = `chat-${serial++}`
    const stub: Record<string, unknown> = { id, name: rand() < 0.3 ? '' : `대화 ${id}`, _stub: true, lastDate: 1727400000000 + serial }
    if (rand() < 0.5) stub.folderId = rand() < 0.5 ? null : 'folder-1'
    return stub
}
function makeCharacter(rand: () => number) {
    const n = serial++
    const character: Record<string, unknown> = {
        name: `캐릭터 ${n}`,
        chaId: `cha-${n}`,
        desc: 'desc '.repeat(1 + Math.floor(rand() * 20)),
        chats: Array.from({ length: 1 + Math.floor(rand() * 5) }, () => makeStub(rand)),
        chatFolders: [{ id: 'folder-1', name: 'F', folded: false }],
        tags: Array.from({ length: Math.floor(rand() * 3) }, (_, i) => `tag${i}`),
        globalLore: Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, k) => ({ key: `k${k}`, content: '로어 '.repeat(5), insertorder: k })),
        extentions: { risuai: { backgroundHTML: '' }, depth_prompt: { depth: 0, prompt: '' } },
        emotionImages: [['happy', 'assets/h.png']],
        lastInteraction: 1727400000000 + n,
    }
    if (rand() < 0.5) character.additionalAssetManifest = { id: `m${n}`, version: 1, count: 3, sha256: 'e'.repeat(64), ownerKind: 'character', ownerId: `cha-${n}` }
    return character
}
function makeModule(rand: () => number) {
    const n = serial++
    return {
        name: `모듈 ${n}`,
        id: `mod-${n}`,
        lorebook: Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, k) => ({ key: `m${k}`, content: 'x'.repeat(20), insertorder: k })),
        regex: [{ in: 'a', out: 'b', type: 'editoutput' }],
    }
}
function makeRoot(rand: () => number): Root {
    return {
        username: 'user',
        characters: Array.from({ length: 12 }, () => makeCharacter(rand)),
        temperature: 80,
        modules: Array.from({ length: 6 }, () => makeModule(rand)),
        personas: [{ name: 'Default', id: 'p0' }, { name: 'Other', id: 'p1' }],
        botPresets: [{ id: 'bp0', name: 'Preset', mainPrompt: 'x'.repeat(100) }],
        characterOrder: ['cha-0'],
        pluginCustomStorage: {},
    }
}

// ---- patch generators ----
type Gen = (rand: () => number, root: Root) => Op[]
const pick = <T>(rand: () => number, list: T[]): T => list[Math.floor(rand() * list.length)]
const idx = (rand: () => number, list: unknown[]) => Math.floor(rand() * Math.max(1, list.length))
const charIdx = (rand: () => number, root: Root) => idx(rand, root.characters)
const modIdx = (rand: () => number, root: Root) => idx(rand, root.modules)

const fieldEdit: Gen = (rand, root) => {
    const i = charIdx(rand, root)
    const m = modIdx(rand, root)
    return [pick(rand, [
        { op: 'replace', path: `/characters/${i}/name`, value: `renamed ${serial++}` },
        { op: 'replace', path: `/characters/${i}/desc`, value: 'new desc' },
        { op: 'add', path: `/characters/${i}/newField`, value: { n: serial++ } },
        { op: 'remove', path: `/characters/${i}/lastInteraction` },
        { op: 'remove', path: `/characters/${i}/additionalAssetManifest` },
        { op: 'replace', path: `/modules/${m}/name`, value: `module ${serial++}` },
        { op: 'add', path: `/modules/${m}/hideIcon`, value: true },
    ])]
}
const nestedEdit: Gen = (rand, root) => {
    const i = charIdx(rand, root)
    const m = modIdx(rand, root)
    return [pick(rand, [
        { op: 'replace', path: `/characters/${i}/globalLore/0/content`, value: 'edited lore' },
        { op: 'add', path: `/characters/${i}/tags/-`, value: `t${serial++}` },
        { op: 'remove', path: `/characters/${i}/tags/0` },
        { op: 'add', path: `/characters/${i}/extentions/risuai/extra`, value: [1, 2, { three: 3 }] },
        { op: 'add', path: `/characters/${i}/extentions/a~1b~0c`, value: 'escaped key' },
        { op: 'replace', path: `/characters/${i}/extentions/depth_prompt/depth`, value: 4 },
        { op: 'replace', path: `/modules/${m}/lorebook/0/content`, value: 'edited' },
        { op: 'add', path: `/modules/${m}/lorebook/-`, value: { key: 'new', content: '', insertorder: 9 } },
    ])]
}
const chatStub: Gen = (rand, root) => {
    const i = charIdx(rand, root)
    const chats = root.characters[i]?.chats ?? []
    const j = idx(rand, chats)
    return [pick(rand, [
        { op: 'replace', path: `/characters/${i}/chats/${j}/lastDate`, value: 1727500000000 + serial++ },
        { op: 'replace', path: `/characters/${i}/chats/${j}/name`, value: `chat ${serial++}` },
        { op: 'add', path: `/characters/${i}/chats/${j}/folderId`, value: 'folder-1' },
        { op: 'add', path: `/characters/${i}/chats/-`, value: makeStub(rand) },
        { op: 'add', path: `/characters/${i}/chats/0`, value: makeStub(rand) },
        { op: 'remove', path: `/characters/${i}/chats/${j}` },
    ])]
}
const elementReplace: Gen = (rand, root) => {
    const i = charIdx(rand, root)
    if (rand() < 0.3) return [{ op: 'replace', path: `/modules/${modIdx(rand, root)}`, value: makeModule(rand) }]
    // A replaced slot then edited: the later op writes into the request's value.
    if (rand() < 0.4) return [
        { op: 'replace', path: `/characters/${i}`, value: makeCharacter(rand) },
        { op: 'replace', path: `/characters/${i}/name`, value: 'edited after replace' },
        { op: 'add', path: `/characters/${i}/chats/-`, value: makeStub(rand) },
    ]
    return [{ op: 'replace', path: `/characters/${i}`, value: makeCharacter(rand) }]
}
const branchReplace: Gen = (rand, root) => {
    if (rand() < 0.5) {
        const keep = structuredClone(root.characters.slice(0, 8))
        return [{ op: 'replace', path: '/characters', value: [...keep, makeCharacter(rand), makeCharacter(rand)] }]
    }
    return [{ op: 'replace', path: '/modules', value: [...structuredClone(root.modules.slice(0, 4)), makeModule(rand)] }]
}
const depthTwo: Gen = (rand, root) => {
    const i = charIdx(rand, root)
    const m = modIdx(rand, root)
    const ops: Op[] = [pick(rand, [
        { op: 'add', path: `/characters/${i}`, value: makeCharacter(rand) },
        { op: 'add', path: '/characters/-', value: makeCharacter(rand) },
        { op: 'remove', path: `/characters/${i}` },
        { op: 'add', path: `/modules/${m}`, value: makeModule(rand) },
        { op: 'add', path: '/modules/-', value: makeModule(rand) },
        { op: 'remove', path: `/modules/${m}` },
    ])]
    // Sometimes with element edits after the shift: at i the op reaches the
    // inserted value or the element that moved into the slot, at i + 1 an
    // element that moved. The indexes checked before the apply are stale.
    if (rand() < 0.5) {
        const key = ops[0].path.startsWith('/modules') ? 'modules' : 'characters'
        const at = key === 'modules' ? m : i
        const target = Math.max(0, at + pick(rand, [-1, 0, 1]))
        if (target < root[key].length) ops.push({ op: 'replace', path: `/${key}/${target}/name`, value: 'after shift' })
    }
    return ops
}
const moveCopy: Gen = (rand, root) => {
    const i = charIdx(rand, root)
    const j = charIdx(rand, root)
    if (rand() < 0.35) return pick(rand, [
        // Out of an element into another key: the element loses a field.
        [{ op: 'move', from: `/characters/${i}/desc`, path: '/movedOut' }],
        [{ op: 'move', from: `/modules/${modIdx(rand, root)}/regex`, path: '/personas/0/regex' }],
        // Into a slot from another key: inserts like an add at depth 2, so a
        // later op under i + 1 reaches the element that was at i.
        [{ op: 'copy', from: '/personas/0', path: `/characters/${i}` }, { op: 'replace', path: `/characters/${i + 1}/name`, value: 'after copy' }],
        [{ op: 'move', from: '/botPresets/0', path: `/characters/${i}` }, { op: 'remove', path: `/characters/${i + 1}/tags` }],
    ] as Op[][])
    return [pick(rand, [
        { op: 'copy', from: `/characters/${i}/name`, path: '/username' },
        { op: 'copy', from: `/modules/${modIdx(rand, root)}`, path: '/modules/-' },
        { op: 'copy', from: `/characters/${i}/chats/0`, path: `/characters/${j}/chats/-` },
        { op: 'move', from: `/characters/${i}/desc`, path: `/characters/${j}/movedDesc` },
        { op: 'move', from: `/characters/${i}`, path: `/characters/${j}` },
        { op: 'copy', from: '/personas/0', path: `/characters/${i}/persona` },
    ])]
}
const rootEdit: Gen = (rand, root) => [pick(rand, [
    { op: 'replace', path: '/username', value: `user ${serial++}` },
    { op: 'add', path: '/extraKey', value: { n: serial++ } },
    { op: 'replace', path: '/personas/0/name', value: 'renamed persona' },
    { op: 'add', path: '/characterOrder/-', value: `cha-${serial++}` },
    { op: 'replace', path: '/temperature', value: 70 },
    ...('extraKey' in root ? [{ op: 'remove', path: '/extraKey' }] : []),
])]
const testOps: Gen = (rand, root) => {
    const i = charIdx(rand, root)
    const character = root.characters[i]
    return [pick(rand, [
        [{ op: 'test', path: `/characters/${i}/name`, value: character?.name }, { op: 'replace', path: `/characters/${i}/desc`, value: 'after test' }],
        [{ op: 'test', path: `/characters/${i}`, value: structuredClone(character) }],
        [{ op: 'test', path: `/characters/${i}/chats/0/_stub`, value: true }],
        [{ op: 'test', path: `/characters/${i}/name`, value: 'certainly not the name' }],
    ])]
}
const failing: Gen = (rand, root) => {
    const i = charIdx(rand, root)
    const n = root.characters.length
    return pick(rand, [
        [{ op: 'replace', path: `/characters/${i}/name`, value: 'before failure' }, { op: 'remove', path: `/characters/${i}/missing` }],
        [{ op: 'replace', path: `/characters/${n + 3}/name`, value: 'out of range' }],
        [{ op: 'add', path: `/characters/${i}/chats/0/x`, value: 1 }, { op: 'test', path: '/username', value: 'nope' }],
        [{ op: 'add', path: `/characters/${i}/chats/99`, value: makeStub(rand) }],
        [{ op: 'replace', path: '/characters/-/name', value: 'dash' }],
        [{ op: 'replace', path: `/modules/${modIdx(rand, root)}/lorebook/0/content`, value: 'x' }, { op: 'replace', path: '/modules/999/name', value: 'y' }],
        [{ op: 'remove', path: `/characters/${i}/chats/0/message/0` }],
        [{ op: 'bogus', path: `/characters/${i}/name`, value: 1 }],
    ] as Op[][])
}
// fast-json-patch applies ~~index to any digit run: '01' is 1, '' is 0 and
// 4294967296 wraps to 0. It refuses writes through them when validating, but
// they must not be trusted as element indexes either way.
const oddIndex: Gen = (rand) => pick(rand, [
    [{ op: 'test', path: '/characters/01/chatFolders/0/id', value: 'folder-1' }, { op: 'replace', path: '/characters/1/name', value: 'after odd test' }],
    [{ op: 'replace', path: '/characters/01/name', value: 'leading zero' }],
    [{ op: 'replace', path: '/characters//name', value: 'empty index' }],
    [{ op: 'replace', path: '/characters/4294967296/name', value: 'wrapped index' }],
    [{ op: 'replace', path: '/characters/4294967297/chats/0/lastDate', value: 5 }],
    [{ op: 'replace', path: '/characters/1e0/name', value: 'exponent' }],
    [{ op: 'replace', path: '/modules/00/name', value: 'double zero' }],
] as Op[][])
const rootOp: Gen = (rand, root) => {
    const replacement = structuredClone(root)
    replacement.username = `root op ${serial++}`
    return [{ op: 'replace', path: '', value: replacement }]
}

const SINGLE: Array<[number, Gen]> = [
    [18, fieldEdit], [14, nestedEdit], [20, chatStub], [6, elementReplace], [3, branchReplace],
    [8, depthTwo], [4, moveCopy], [6, rootEdit], [5, testOps], [8, failing], [4, oddIndex], [1, rootOp],
]
const SAFE: Gen[] = [fieldEdit, nestedEdit, chatStub, rootEdit]
function generatePatch(rand: () => number, root: Root): Op[] {
    if (rand() < 0.12) {
        // A client save: several independent edits in one patch.
        const ops: Op[] = []
        const count = 2 + Math.floor(rand() * 3)
        for (let k = 0; k < count; k++) ops.push(...pick(rand, SAFE)(rand, root))
        return ops
    }
    const total = SINGLE.reduce((sum, [w]) => sum + w, 0)
    let r = rand() * total
    for (const [weight, gen] of SINGLE) {
        if ((r -= weight) < 0) return gen(rand, root)
    }
    return fieldEdit(rand, root)
}

// ---- the spec of "non-structural", written independently of the module ----
const CANONICAL = /^(?:0|[1-9][0-9]*)$/
// For root array `key`: null when the patch may restructure it, otherwise the
// indexes whose element may be replaced by a copy (changed in place at depth
// >= 3, or swapped out by a depth-2 replace).
function expectedChangedIndexes(key: string, array: unknown[], patch: Op[]): Set<number> | null {
    const changed = new Set<number>()
    for (const op of patch) {
        for (const field of ['path', 'from'] as const) {
            const pointer = op[field]
            if (typeof pointer !== 'string') continue
            if (pointer === '' || !pointer.startsWith('/')) return null
            const parts = pointer.split('/')
            if (legacyDecodePointerSegment(parts[1]) !== key) continue
            if (field === 'from' || !['add', 'replace', 'remove', 'test'].includes(op.op)) return null
            if (parts.length < 3 || !CANONICAL.test(parts[2]) || Number(parts[2]) >= array.length) return null
            if (parts.length === 3 && (op.op === 'add' || op.op === 'remove')) return null
            if (op.op !== 'test') changed.add(Number(parts[2]))
        }
    }
    return changed
}
function touchesKey(key: string, patch: Op[]) {
    return patch.some((op) => [op.path, op.from].some((p) => typeof p === 'string'
        && (p === '' || !p.startsWith('/') || legacyDecodePointerSegment(p.split('/')[1]) === key)))
}

function runFuzz(seed: number, iterations: number, frozen: boolean) {
    serial = 0
    const rand = mulberry32(seed)
    const cache = createPatchHashCache(calculateHash)
    let prev: Root = makeRoot(rand)
    if (frozen) deepFreeze(prev)
    expect(cache.hash(prev)).toBe(calculateHash(prev))
    const stats = { applied: 0, failed: 0, nonStructural: 0, sharedChecked: 0, clonedChecked: 0 }

    for (let n = 0; n < iterations; n++) {
        if (prev.characters.length < 4) prev = frozen ? deepFreeze({ ...prev, characters: [...prev.characters, makeCharacter(rand), makeCharacter(rand)] }) : { ...prev, characters: [...prev.characters, makeCharacter(rand), makeCharacter(rand)] }
        const patch = generatePatch(rand, prev)
        const where = `seed ${seed} #${n} ${JSON.stringify(patch).slice(0, 300)}`
        const prevBytes = encodeRisuSaveLegacyBuffer(prev)
        const newPatch = structuredClone(patch)
        const oldPatch = structuredClone(patch)

        let next: Root | undefined
        let newError: any
        try {
            next = applyPatch(clonePatchSnapshot(prev, newPatch), newPatch, true).newDocument
        } catch (error) {
            newError = error
        }
        let reference: Root | undefined
        let oldError: any
        try {
            reference = applyPatch(legacyClonePatchSnapshot(prev, oldPatch), oldPatch, true).newDocument
        } catch (error) {
            oldError = error
        }

        // The previous root is untouched whatever happened.
        expect(encodeRisuSaveLegacyBuffer(prev).equals(prevBytes), `previous root changed: ${where}`).toBe(true)
        expect(!!newError, `failure differs: ${where} new=${newError?.message} old=${oldError?.message}`).toBe(!!oldError)
        if (newError) {
            expect(newError.name).toBe(oldError.name)
            expect(newError.message).toBe(oldError.message)
            stats.failed++
            continue
        }
        if (next === null || typeof next !== 'object' || Array.isArray(next)) {
            // A root op may leave a non-object; the server refuses it (400).
            expect(reference).toStrictEqual(next)
            continue
        }
        stats.applied++

        // Same root, byte for byte (so also the same key order).
        expect(encodeRisuSaveLegacyBuffer(next).equals(encodeRisuSaveLegacyBuffer(reference)), `result differs: ${where}`).toBe(true)
        expect(next).toStrictEqual(reference)

        // The protocol hash.
        const fullHash = calculateHash(next)
        expect(calculateHash(reference)).toBe(fullHash)
        expect(cache.update(prev, next, newPatch), `hash: ${where}`).toBe(fullHash)
        expect(cache.hash(next)).toBe(fullHash)
        if (n % 25 === 0) {
            const keyHashes = cache.keyHashes(next)
            for (const key of Object.keys(next)) expect(keyHashes[key]).toBe(calculateHash(next[key]))
            for (const character of next.characters ?? []) expect(cache.elementHash(character)).toBe(calculateHash(character))
        }

        // Identity of untouched elements.
        for (const key of ['characters', 'modules']) {
            if (!Array.isArray(prev[key])) continue
            if (!touchesKey(key, patch)) {
                expect(next[key], `untouched branch not shared: ${where}`).toBe(prev[key])
                continue
            }
            const changed = expectedChangedIndexes(key, prev[key], patch)
            if (!changed) continue
            stats.nonStructural++
            expect(next[key]).not.toBe(prev[key])
            expect(next[key].length).toBe(prev[key].length)
            prev[key].forEach((element: unknown, i: number) => {
                if (changed.has(i)) {
                    expect(next![key][i], `changed element is shared: ${where}`).not.toBe(element)
                    stats.clonedChecked++
                } else {
                    expect(next![key][i], `untouched element ${key}[${i}] lost its identity: ${where}`).toBe(element)
                    stats.sharedChecked++
                }
            })
        }

        prev = frozen ? deepFreeze(next) : next
    }
    return stats
}

describe('B2 element-level patch sharing (fuzz against the whole-branch clone)', () => {
    for (const frozen of [true, false]) {
        it(`1,000 random patches, ${frozen ? 'frozen' : 'unfrozen'} roots`, () => {
            const stats = runFuzz(frozen ? 0xb2f0 : 0xb2f1, 1000, frozen)
            // The mix really exercises each side (a run gives about 780
            // applied, 215 failed, 610 non-structural, 5,000 shared and 690
            // cloned elements checked).
            expect(stats.applied).toBeGreaterThan(600)
            expect(stats.failed).toBeGreaterThan(100)
            expect(stats.nonStructural).toBeGreaterThan(400)
            expect(stats.sharedChecked).toBeGreaterThan(3000)
            expect(stats.clonedChecked).toBeGreaterThan(300)
        }, 120_000)
    }
})
