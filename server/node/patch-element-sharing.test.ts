// B2 fuzz: element-level patch snapshots (patch-selective-clone.cjs) and the
// element hash memo (patch-hash-cache.cjs) against the pre-B2 clone path.
//
// Every patch is applied three times to the same previous root: the way
// /api/patch does now (applyPatchCopyOnWrite), through clonePatchSnapshot
// plus applyPatch, and through a verbatim copy of the old clonePatchSnapshot
// (every touched top-level branch cloned whole). Checked after each patch:
//  - all paths fail with the same error, or all succeed with byte-identical
//    roots;
//  - the cached hash equals calculateHash (the protocol hash) of the result,
//    and the memo hashed exactly the objects that are new in it;
//  - the previous root encodes to the same bytes as before;
//  - copy-on-write: every characters[i] / modules[i] no op wrote into is the
//    previous root's own object, wherever add, remove, move and copy put it,
//    and nothing else is;
//  - in a non-structural patch, every characters[i] / modules[i] no op
//    changes is also shared by clonePatchSnapshot.
// It runs once with roots deep-frozen as the server installs them under
// POCKETRISU_TEST_FREEZE_CACHE, and once unfrozen, where a missed clone would
// really write into the previous root and fail the bytes check.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const requireCjs = createRequire(import.meta.url)
const { clonePatchSnapshot, applyPatchCopyOnWrite } = requireCjs('./patch-selective-clone.cjs')
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

// ---- structural patches (copy-on-write) ----
const arrayKey = (rand: () => number) => (rand() < 0.7 ? 'characters' : 'modules')
const makeFor = (key: string) => (key === 'characters' ? makeCharacter : makeModule)
// A character or module create/delete as the client sends it: removes
// (descending), adds at their final indexes (ascending), then edits at final
// indexes, which may land on an added value, a shifted element or neither.
const clientStructural: Gen = (rand, root) => {
    const key = arrayKey(rand)
    const make = makeFor(key)
    const ops: Op[] = []
    const removes = [...new Set(Array.from({ length: Math.floor(rand() * 3) }, () => idx(rand, root[key])))].sort((a, b) => b - a)
    for (const i of removes) ops.push({ op: 'remove', path: `/${key}/${i}` })
    let size = root[key].length - removes.length
    const adds = Math.floor(rand() * 3) + (removes.length === 0 ? 1 : 0)
    const positions = Array.from({ length: adds }, () => Math.floor(rand() * (size + adds))).sort((a, b) => a - b)
    for (const at of positions) {
        const index = Math.min(at, size)
        ops.push({ op: 'add', path: index === size && rand() < 0.3 ? `/${key}/-` : `/${key}/${index}`, value: make(rand) })
        size++
    }
    const edits = Math.floor(rand() * 4)
    for (let k = 0; k < edits; k++) {
        const i = Math.floor(rand() * Math.max(1, size))
        ops.push(pick(rand, key === 'characters' ? [
            { op: 'replace', path: `/characters/${i}/name`, value: `edited ${serial++}` },
            { op: 'add', path: `/characters/${i}/chats/-`, value: makeStub(rand) },
            { op: 'replace', path: `/characters/${i}/chats/0/lastDate`, value: 1727600000000 + serial++ },
            { op: 'remove', path: `/characters/${i}/desc` },
            { op: 'test', path: `/characters/${i}/chatFolders/0/id`, value: 'folder-1' },
            { op: 'replace', path: `/characters/${i}`, value: makeCharacter(rand) },
        ] : [
            { op: 'replace', path: `/modules/${i}/name`, value: `edited ${serial++}` },
            { op: 'add', path: `/modules/${i}/lorebook/-`, value: { key: 'k', content: 'c', insertorder: 1 } },
            { op: 'remove', path: `/modules/${i}/regex` },
        ]))
    }
    return ops
}
// Moves and copies inside the array, mixed with reads and writes of the
// elements they shift.
const inArrayMoves: Gen = (rand, root) => {
    const key = arrayKey(rand)
    const ops: Op[] = []
    let size = root[key].length
    const steps = 1 + Math.floor(rand() * 4)
    for (let k = 0; k < steps; k++) {
        const i = Math.floor(rand() * size)
        const r = rand()
        if (r < 0.35) {
            ops.push({ op: 'move', from: `/${key}/${i}`, path: rand() < 0.2 ? `/${key}/-` : `/${key}/${Math.floor(rand() * size)}` })
        } else if (r < 0.55) {
            ops.push({ op: 'copy', from: `/${key}/${i}`, path: rand() < 0.2 ? `/${key}/-` : `/${key}/${Math.floor(rand() * (size + 1))}` })
            size++
        } else if (r < 0.7) {
            ops.push({ op: 'test', path: `/${key}/${i}/name`, value: root[key][i]?.name ?? 'none' })
        } else {
            ops.push({ op: 'replace', path: `/${key}/${i}/name`, value: `after move ${serial++}` })
        }
    }
    return ops
}
// Structural ops that fail, alone or after ops that already ran.
const structuralFailing: Gen = (rand, root) => {
    const key = arrayKey(rand)
    const make = makeFor(key)
    const n = root[key].length
    const i = idx(rand, root[key])
    return pick(rand, [
        [{ op: 'add', path: `/${key}/${n + 1}`, value: make(rand) }],
        [{ op: 'remove', path: `/${key}/${n}` }],
        [{ op: 'remove', path: `/${key}/${i}` }, { op: 'replace', path: `/${key}/${n - 1}/name`, value: 'shifted out' }],
        [{ op: 'add', path: `/${key}/0`, value: make(rand) }, { op: 'replace', path: `/${key}/${i}/name`, value: 'x' }, { op: 'remove', path: `/${key}/${n + 1}` }],
        [{ op: 'move', from: `/${key}/${n}`, path: `/${key}/0` }],
        [{ op: 'remove', path: `/${key}/${i}` }, { op: 'test', path: `/${key}/${i}`, value: structuredClone(root[key][i]) }],
        [{ op: 'copy', from: `/${key}/${i}`, path: `/${key}/0` }, { op: 'replace', path: `/${key}/0/name`, value: 'copy' }, { op: 'remove', path: `/${key}/0/missing` }],
        [{ op: 'add', path: `/${key}/-`, value: make(rand) }, { op: 'add', path: `/${key}/${n}/x/y`, value: 1 }],
        // Structural, then an op that takes the whole branch, then a failure.
        [{ op: 'remove', path: `/${key}/${i}` }, { op: 'move', from: `/${key}/0/name`, path: `/${key}/1/name` }, { op: 'test', path: '/username', value: 'nope' }],
    ] as Op[][])
}

type Mix = Array<[number, Gen]>
const SINGLE: Mix = [
    [18, fieldEdit], [14, nestedEdit], [20, chatStub], [6, elementReplace], [3, branchReplace],
    [8, depthTwo], [4, moveCopy], [6, rootEdit], [5, testOps], [8, failing], [4, oddIndex], [1, rootOp],
    [10, clientStructural], [6, inArrayMoves], [5, structuralFailing],
]
const STRUCTURAL: Mix = [
    [12, clientStructural], [8, inArrayMoves], [5, structuralFailing], [6, chatStub], [4, fieldEdit],
    [3, depthTwo], [2, moveCopy], [1, branchReplace],
]
const SAFE: Gen[] = [fieldEdit, nestedEdit, chatStub, rootEdit]
function patchGenerator(mix: Mix) {
    const total = mix.reduce((sum, [w]) => sum + w, 0)
    return (rand: () => number, root: Root): Op[] => {
        if (rand() < 0.12) {
            // A client save: several independent edits in one patch.
            const ops: Op[] = []
            const count = 2 + Math.floor(rand() * 3)
            for (let k = 0; k < count; k++) ops.push(...pick(rand, SAFE)(rand, root))
            return ops
        }
        let r = rand() * total
        for (const [weight, gen] of mix) {
            if ((r -= weight) < 0) return gen(rand, root)
        }
        return fieldEdit(rand, root)
    }
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

// ---- the spec of copy-on-write, written independently of the module ----
// For root array `key`: null when the patch gets a whole-branch copy of it.
// Otherwise the ops that name it are replayed on the previous indexes:
// `slots` says where each element of the result comes from (an index of the
// previous array, or null for a value the patch brought in: an add or
// replace value, a copy), `written` which previous elements an op wrote into
// (add, replace or remove below /key/N), each of which must be a copy.
// fast-json-patch reads an index as ~~segment, '-' as the length, and
// splices, so a move or copy past the end appends.
function expectedCopyOnWrite(key: string, prevLength: number, patch: Op[]) {
    const under = (pointer: unknown) => (typeof pointer === 'string' && pointer.startsWith('/')
        && legacyDecodePointerSegment(pointer.split('/')[1]) === key ? pointer.split('/') : null)
    const slot = (parts: string[] | null, end: boolean) => !!parts && parts.length === 3 && (CANONICAL.test(parts[2]) || (end && parts[2] === '-'))
    for (const op of patch) {
        if ([op.path, op.from].some((p) => typeof p === 'string' && (p === '' || !p.startsWith('/')))) return null
        const path = under(op.path)
        const from = under(op.from)
        if (!path && !from) continue
        if (op.op === 'move' || op.op === 'copy') {
            if (!slot(from, false) || !slot(path, true)) return null
            continue
        }
        if (from) return null
        if (op.op === 'test') continue
        if (!['add', 'replace', 'remove'].includes(op.op) || !path || path.length < 3) return null
        if (!CANONICAL.test(path[2]) && !(op.op === 'add' && slot(path, true))) return null
    }
    const slots: Array<number | null> = Array.from({ length: prevLength }, (_, i) => i)
    const written = new Set<number>()
    let structural = false
    const at = (segment: string) => (segment === '-' ? slots.length : ~~segment)
    for (const op of patch) {
        const path = under(op.path)
        if (!path || op.op === 'test') continue
        if (path.length > 3) {
            const source = slots[~~path[2]]
            if (typeof source === 'number') written.add(source)
            continue
        }
        if (op.op === 'replace') {
            slots[~~path[2]] = null
            continue
        }
        structural = true
        if (op.op === 'add' || op.op === 'copy') slots.splice(at(path[2]), 0, null)
        else if (op.op === 'remove') slots.splice(~~path[2], 1)
        else if (op.op === 'move') {
            const [moved] = slots.splice(~~under(op.from)![2], 1)
            slots.splice(at(path[2]), 0, moved)
        }
    }
    return { slots, written, structural }
}

function runFuzz(seed: number, iterations: number, frozen: boolean, generate = patchGenerator(SINGLE)) {
    serial = 0
    const rand = mulberry32(seed)
    // Every object the hash cache hands to calculateHash.
    const hashedObjects: object[] = []
    const cache = createPatchHashCache((value: unknown) => {
        if (value !== null && typeof value === 'object') hashedObjects.push(value)
        return calculateHash(value)
    })
    // The elements of root arrays the cache's memo holds.
    const memoized = new WeakSet<object>()
    const noteMemoized = (root: Root) => {
        for (const value of Object.values(root)) {
            if (Array.isArray(value)) for (const e of value) if (e !== null && typeof e === 'object') memoized.add(e)
        }
    }
    const install = (root: Root) => (frozen ? deepFreeze(root) : root)
    let prev: Root = install(makeRoot(rand))
    expect(cache.hash(prev)).toBe(calculateHash(prev))
    noteMemoized(prev)
    const stats = {
        applied: 0, failed: 0, nonStructural: 0, sharedChecked: 0, clonedChecked: 0,
        cowStructural: 0, cowShared: 0, cowCopied: 0, cowNew: 0, cowWhole: 0, hashedNew: 0,
    }

    for (let n = 0; n < iterations; n++) {
        if (prev.characters.length < 4 || prev.modules.length < 2) {
            prev = install({
                ...prev,
                characters: [...prev.characters, makeCharacter(rand), makeCharacter(rand)],
                modules: [...prev.modules, makeModule(rand), makeModule(rand)],
            })
            cache.hash(prev)
            noteMemoized(prev)
        }
        const patch = generate(rand, prev)
        const where = `seed ${seed} #${n} ${JSON.stringify(patch).slice(0, 300)}`
        const prevBytes = encodeRisuSaveLegacyBuffer(prev)
        // Each apply gets its own ops: applyPatch links op values into its result.
        const cowPatch = structuredClone(patch)
        const newPatch = structuredClone(patch)
        const oldPatch = structuredClone(patch)

        let cowNext: Root | undefined
        let cowError: any
        try {
            cowNext = applyPatchCopyOnWrite(prev, cowPatch).newDocument
        } catch (error) {
            cowError = error
        }
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
        expect(!!cowError, `failure differs: ${where} copy-on-write=${cowError?.message?.split('\n')[0]} old=${oldError?.message?.split('\n')[0]}`).toBe(!!oldError)
        expect(!!newError, `failure differs: ${where} new=${newError?.message} old=${oldError?.message}`).toBe(!!oldError)
        if (oldError) {
            // applyPatchCopyOnWrite builds its errors without the document
            // (patch-validated-apply.cjs), so only the message's first line
            // is the library's.
            for (const error of [cowError, newError]) {
                expect(error.name).toBe(oldError.name)
                expect(error.message.split('\n', 1)[0]).toBe(oldError.message.split('\n', 1)[0])
                expect(error.index).toBe(oldError.index)
                expect(error.operation).toEqual(oldError.operation)
            }
            expect(newError.message).toBe(oldError.message)
            stats.failed++
            continue
        }
        if (reference === null || typeof reference !== 'object' || Array.isArray(reference)) {
            // A root op may leave a non-object; the server refuses it (400).
            expect(next).toStrictEqual(reference)
            expect(cowNext).toStrictEqual(reference)
            continue
        }
        stats.applied++

        // Same root, byte for byte (so also the same key order).
        const referenceBytes = encodeRisuSaveLegacyBuffer(reference)
        expect(encodeRisuSaveLegacyBuffer(cowNext).equals(referenceBytes), `result differs: ${where}`).toBe(true)
        expect(encodeRisuSaveLegacyBuffer(next).equals(referenceBytes), `result differs: ${where}`).toBe(true)
        expect(cowNext).toStrictEqual(reference)
        expect(next).toStrictEqual(reference)
        cowNext = cowNext!
        next = next!

        // The protocol hash, and what it cost: the memo hashes exactly the
        // array elements it has not seen (the new ones) of the branches the
        // patch names (all of them for a root op), plus those branches that
        // are not arrays.
        const fullHash = calculateHash(cowNext)
        expect(calculateHash(reference)).toBe(fullHash)
        hashedObjects.length = 0
        expect(cache.update(prev, cowNext, cowPatch), `hash: ${where}`).toBe(fullHash)
        const { keys: namedKeys, touchesRoot } = legacyCollectPatchTopLevelKeys(cowPatch)
        const expectedHashed = new Set<object>()
        for (const key of touchesRoot ? Object.keys(cowNext) : namedKeys) {
            if (!Object.prototype.hasOwnProperty.call(cowNext, key)) continue
            const value = cowNext[key]
            if (Array.isArray(value)) {
                for (const e of value) if (e !== null && typeof e === 'object' && !memoized.has(e)) expectedHashed.add(e)
            } else if (value !== null && typeof value === 'object') {
                expectedHashed.add(value)
            }
        }
        expect(hashedObjects.length, `objects hashed: ${where}`).toBe(expectedHashed.size)
        for (const value of hashedObjects) expect(expectedHashed.has(value), `hashed an object that is not new: ${where}`).toBe(true)
        stats.hashedNew += hashedObjects.length
        noteMemoized(cowNext)
        expect(cache.hash(cowNext)).toBe(fullHash)
        if (n % 25 === 0) {
            const keyHashes = cache.keyHashes(cowNext)
            for (const key of Object.keys(cowNext)) expect(keyHashes[key]).toBe(calculateHash(cowNext[key]))
            for (const character of cowNext.characters ?? []) expect(cache.elementHash(character)).toBe(calculateHash(character))
        }

        // Copy-on-write identity.
        for (const key of ['characters', 'modules']) {
            if (!Array.isArray(prev[key])) continue
            if (!touchesKey(key, patch)) {
                expect(cowNext[key], `untouched branch not shared: ${where}`).toBe(prev[key])
                continue
            }
            const previousElements = new Set<unknown>(prev[key])
            const isPrevious = (element: unknown) => element !== null && typeof element === 'object' && previousElements.has(element)
            const spec = expectedCopyOnWrite(key, prev[key].length, patch)
            if (!spec) {
                // The whole branch: no previous element survives as itself.
                for (const element of Array.isArray(cowNext[key]) ? cowNext[key] : []) {
                    expect(isPrevious(element), `whole-branch copy shares ${key}: ${where}`).toBe(false)
                }
                stats.cowWhole++
                continue
            }
            if (spec.structural) stats.cowStructural++
            expect(cowNext[key]).not.toBe(prev[key])
            expect(cowNext[key].length, `${key} length: ${where}`).toBe(spec.slots.length)
            spec.slots.forEach((source, j) => {
                const element = cowNext![key][j]
                if (source === null || spec.written.has(source)) {
                    expect(isPrevious(element), `${key}[${j}] is a previous element: ${where}`).toBe(false)
                    if (source === null) stats.cowNew++
                    else stats.cowCopied++
                } else {
                    expect(element, `${key}[${j}] (was [${source}]) lost its identity: ${where}`).toBe(prev[key][source])
                    stats.cowShared++
                }
            })
        }

        // clonePatchSnapshot: identity of untouched elements.
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

        prev = install(cowNext)
    }
    return stats
}

describe('B2 element-level patch sharing (fuzz against the whole-branch clone)', () => {
    for (const frozen of [true, false]) {
        it(`1,000 random patches, ${frozen ? 'frozen' : 'unfrozen'} roots`, () => {
            const stats = runFuzz(frozen ? 0xb2f0 : 0xb2f1, 1000, frozen)
            // The mix really exercises each side (a run gives about 760
            // applied, 235 failed, 510 non-structural with 5,700 shared and
            // 580 cloned elements checked; copy-on-write: 180 structural
            // patches, 7,600 shared, 670 copied and 230 new elements, 55
            // whole branches).
            expect(stats.applied).toBeGreaterThan(600)
            expect(stats.failed).toBeGreaterThan(100)
            expect(stats.nonStructural).toBeGreaterThan(350)
            expect(stats.sharedChecked).toBeGreaterThan(3000)
            expect(stats.clonedChecked).toBeGreaterThan(300)
            expect(stats.cowStructural).toBeGreaterThan(120)
            expect(stats.cowShared).toBeGreaterThan(5000)
            expect(stats.cowCopied).toBeGreaterThan(400)
            expect(stats.cowNew).toBeGreaterThan(150)
            expect(stats.cowWhole).toBeGreaterThan(30)
        }, 120_000)
        it(`800 structural patches, ${frozen ? 'frozen' : 'unfrozen'} roots`, () => {
            const stats = runFuzz(frozen ? 0xc0f0 : 0xc0f1, 800, frozen, patchGenerator(STRUCTURAL))
            // About 660 applied, 140 failed; 350 structural patches, 8,700
            // shared, 630 copied and 370 new elements, 40 whole branches.
            expect(stats.applied).toBeGreaterThan(500)
            expect(stats.failed).toBeGreaterThan(80)
            expect(stats.cowStructural).toBeGreaterThan(250)
            expect(stats.cowShared).toBeGreaterThan(5000)
            expect(stats.cowCopied).toBeGreaterThan(400)
            expect(stats.cowNew).toBeGreaterThan(250)
            expect(stats.cowWhole).toBeGreaterThan(20)
        }, 120_000)
    }
})

describe('copy-on-write patches and the hash memo', () => {
    it('a character create or delete hashes only the new character', () => {
        serial = 0
        const rand = mulberry32(0xadd)
        const hashed: object[] = []
        const cache = createPatchHashCache((value: unknown) => {
            if (value !== null && typeof value === 'object') hashed.push(value)
            return calculateHash(value)
        })
        let root: Root = deepFreeze(makeRoot(rand))
        cache.hash(root)
        // The objects the memo hashed for one patch; all of them characters.
        const step = (patch: Op[]) => {
            const next = deepFreeze(applyPatchCopyOnWrite(root, patch).newDocument)
            hashed.length = 0
            expect(cache.update(root, next, patch)).toBe(calculateHash(next))
            for (const value of hashed) expect(next.characters).toContain(value)
            root = next
            return hashed.slice()
        }

        const created = makeCharacter(rand)
        const onCreate = step([{ op: 'add', path: `/characters/${root.characters.length}`, value: created }])
        expect(onCreate).toHaveLength(1)
        expect(onCreate[0]).toBe(created)
        const atFront = makeCharacter(rand)
        const onFront = step([{ op: 'add', path: '/characters/0', value: atFront }])
        expect(onFront).toHaveLength(1)
        expect(onFront[0]).toBe(atFront)
        const before = root.characters
        expect(step([{ op: 'remove', path: `/characters/${root.characters.length - 1}` }])).toEqual([])
        expect(step([{ op: 'remove', path: '/characters/0' }, { op: 'remove', path: '/characters/3' }])).toEqual([])
        expect(root.characters).toEqual(before.filter((_: unknown, i: number) => i !== 0 && i !== 4 && i !== before.length - 1))
        // The client's shape: removes, an add, an edit of a shifted character.
        const edited = root.characters[5]
        const hashedNow = step([
            { op: 'remove', path: '/characters/2' },
            { op: 'add', path: '/characters/1', value: makeCharacter(rand) },
            { op: 'replace', path: '/characters/5/name', value: 'edited' },
        ])
        expect(hashedNow).toHaveLength(2)
        expect(root.characters[5]).not.toBe(edited)
        expect(root.characters[5].name).toBe('edited')
        expect(hashedNow).toContain(root.characters[5])
        expect(hashedNow).toContain(root.characters[1])
    })
})
