// patch-validated-apply.cjs: fast-json-patch's decisions without its cost
// for a rejected op.
//  - On a large document every kind of rejection (and a move, which the
//    library checks on a JSON copy of the whole document) returns within a
//    time bound, through applyValidatedPatch and applyPatchCopyOnWrite, with
//    no document in the error.
//  - Fuzz: random patches, most of them invalid in one way or another,
//    against applyPatch(copy, patch, true). Both accept the same patches with
//    the same results, or both throw at the same op with the same error.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'

const requireCjs = createRequire(import.meta.url)
const { applyValidatedPatch, DOCUMENT_PLACEHOLDER } = requireCjs('./patch-validated-apply.cjs')
const { applyPatchCopyOnWrite, copyOnWriteEligible } = requireCjs('./patch-selective-clone.cjs')
// The same fast-json-patch build server.cjs requires.
const { applyPatch, JsonPatchError } = requireCjs('fast-json-patch')

type Op = Record<string, unknown>

function attempt(fn: () => any): { result?: any, error?: any } {
    try {
        return { result: fn() }
    } catch (error) {
        return { error }
    }
}
const firstLine = (error: any) => String(error?.message).split('\n', 1)[0]
// Deep equality that tells a missing key from an undefined one. (toStrictEqual
// also compares .constructor, which the fuzz documents have as an own key.)
function expectSame(actual: unknown, expected: unknown, where: string) {
    if (isDeepStrictEqual(actual, expected)) return
    expect(actual, where).toEqual(expected)
    expect.fail(`${where}: differ in undefined keys or prototypes`)
}

// A JsonPatchError from the module never carries the document.
function expectNoDocument(error: any) {
    if (!(error instanceof JsonPatchError)) return
    expect(error.tree === undefined || error.tree === DOCUMENT_PLACEHOLDER, `tree of ${error.name}`).toBe(true)
}

it('mirrors the fast-json-patch version whose core.js it follows', () => {
    // The walk in patch-validated-apply.cjs is written against 3.1.1: after
    // an upgrade, compare it with the new core.js before changing this.
    expect(requireCjs('fast-json-patch/package.json').version).toBe('3.1.1')
})

describe('a rejected patch on a large document', () => {
    // About 60MB of JSON, like a real client view in shape: characters with
    // chat stubs (the first one without lastDate) and long text.
    const text = 'x'.repeat(2000)
    const document: Record<string, any> = {
        username: 'user',
        characters: Array.from({ length: 5000 }, (_, i) => ({
            chaId: `cha-${i}`,
            name: `character ${i}`,
            desc: text,
            chats: Array.from({ length: 6 }, (_, j) => (j === 0
                ? { id: `chat-${i}-${j}`, name: 'stub', _stub: true }
                : { id: `chat-${i}-${j}`, name: 'stub', _stub: true, lastDate: 1727400000000 + j })),
            // The constructor op below reads .test of its container.
            globalLore: Array.from({ length: 5 }, (_, k) => ({ key: `k${k}`, content: text, ...(k === 0 ? { test: false } : {}) })),
        })),
        modules: [{ id: 'mod-0', name: 'module', lorebook: [] }],
    }
    const jsonLength = JSON.stringify(document).length
    const BOUND_MS = 50

    // [patch, error name, op index]; each fails without changing anything.
    const cases: Array<[Op[], string, number]> = [
        // The rejection that was measured: a stub without lastDate.
        [[{ op: 'replace', path: '/characters/5/chats/0/lastDate', value: 1 }], 'OPERATION_PATH_UNRESOLVABLE', 0],
        [[{ op: 'remove', path: '/characters/5/missing' }], 'OPERATION_PATH_UNRESOLVABLE', 0],
        [[{ op: 'add', path: '/characters/5/missing/deeper', value: 1 }], 'OPERATION_PATH_CANNOT_ADD', 0],
        [[{ op: 'add', path: '/characters/5000', value: 1 }, { op: 'add', path: '/characters/5002', value: {} }], 'OPERATION_VALUE_OUT_OF_BOUNDS', 1],
        [[{ op: 'add', path: '/characters/x', value: {} }], 'OPERATION_PATH_ILLEGAL_ARRAY_INDEX', 0],
        [[{ op: 'replace', path: '/characters/length/name', value: 'x' }], 'OPERATION_PATH_ILLEGAL_ARRAY_INDEX', 0],
        [[{ op: 'replace', path: '/username/deeper', value: 'x' }], 'OPERATION_PATH_UNRESOLVABLE', 0],
        [[{ op: 'replace', path: '/characters/7/name', value: 'x' }, { op: 'test', path: '/characters/7/name', value: 'nope' }], 'TEST_OPERATION_FAILED', 1],
        [[{ op: 'move', from: '/characters/9/missing', path: '/characters/9/moved' }], 'OPERATION_FROM_UNRESOLVABLE', 0],
        [[{ op: 'copy', from: '/characters/99999', path: '/characters/0' }], 'OPERATION_FROM_UNRESOLVABLE', 0],
        [[{ op: 'valueOf', path: '/characters/3/name', test: false }], 'TEST_OPERATION_FAILED', 0],
        [[{ op: 'constructor', path: '/characters/3/globalLore/0/content' }], 'TEST_OPERATION_FAILED', 0],
        [[{ op: 'bogus', path: '/characters/3/name' }], 'OPERATION_OP_INVALID', 0],
    ]
    // Root ops; applyPatchCopyOnWrite copies the whole root for them, so
    // they are timed on applyValidatedPatch alone.
    const rootCases: Array<[Op[], string, number]> = [
        [[{ op: 'test', path: '', value: { username: 'user' } }], 'TEST_OPERATION_FAILED', 0],
        [[{ op: 'toString', path: '' }], 'OPERATION_OP_INVALID', 0],
    ]

    // The fastest of three runs, so a GC pause in one does not count.
    function fastest(run: () => any) {
        let best = Infinity
        let outcome: { result?: any, error?: any } = {}
        for (let k = 0; k < 3; k++) {
            const start = performance.now()
            outcome = attempt(run)
            best = Math.min(best, performance.now() - start)
        }
        return { ms: best, ...outcome }
    }

    it('is large enough that formatting it would take far longer than the bound', () => {
        expect(jsonLength).toBeGreaterThan(50_000_000)
        // What the library itself does with one of these patches.
        const { error } = attempt(() => applyPatch(document, [{ op: 'remove', path: '/characters/5/missing' }], true))
        expect(error?.name).toBe('OPERATION_PATH_UNRESOLVABLE')
        expect(error.message.length).toBeGreaterThan(jsonLength)
    }, 60_000)

    it(`throws the library's error within ${BOUND_MS} ms`, () => {
        const characters = document.characters
        const firstCharacter = characters[0]
        const runs: Array<[string, Op[], string, number, (patch: Op[]) => any]> = []
        const timed = new Set<Op[]>()
        for (const [patch, name, index] of cases) {
            // applyValidatedPatch writes the ops before the failing one into
            // `document`.
            if (patch.length === 1) runs.push(['applyValidatedPatch', patch, name, index, (p) => applyValidatedPatch(document, p)])
            // For any other patch applyPatchCopyOnWrite copies the whole
            // characters array first, succeed or fail (a cost of its own).
            if (copyOnWriteEligible('characters', patch)) runs.push(['applyPatchCopyOnWrite', patch, name, index, (p) => applyPatchCopyOnWrite(document, p)])
        }
        for (const [patch, name, index] of rootCases) {
            runs.push(['applyValidatedPatch', patch, name, index, (p) => applyValidatedPatch(document, p)])
        }
        for (const [label, patch, name, index, apply] of runs) {
            const where = `${label} ${JSON.stringify(patch)}`
            // Each run gets its own ops: an add links its value into the result.
            const { ms, error } = fastest(() => apply(structuredClone(patch)))
            expect(error?.name, where).toBe(name)
            expect(error.index, where).toBe(index)
            expect(error.operation, where).toEqual(patch[index])
            expect(error.message.length, where).toBeLessThan(1000)
            expectNoDocument(error)
            expect(ms, where).toBeLessThan(BOUND_MS)
            timed.add(patch)
        }
        expect(timed.size).toBe(cases.length + rootCases.length)
        // Nothing was changed along the way.
        expect(document.characters).toBe(characters)
        expect(characters).toHaveLength(5000)
        expect(characters[0]).toBe(firstCharacter)
        expect(characters[7].name).toBe('character 7')
    })

    it(`applies a move without copying the document, within ${BOUND_MS} ms`, () => {
        // validator() looks `from` up in a JSON copy of the whole document.
        const { ms, result, error } = fastest(() => applyPatchCopyOnWrite(document, [{ op: 'move', from: '/characters/1', path: '/characters/0' }]))
        expect(error).toBeUndefined()
        expect(result.newDocument.characters[0]).toBe(document.characters[1])
        expect(result.newDocument.characters[1]).toBe(document.characters[0])
        expect(ms).toBeLessThan(BOUND_MS)
    })
})

// ---- fuzz against applyPatch(copy, patch, true) ----
function mulberry32(seed: number) {
    return () => {
        seed |= 0
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}
const pick = <T>(rand: () => number, list: readonly T[]): T => list[Math.floor(rand() * list.length)]

// Keys that stress the walk: escapes, digits, '-', '', array and prototype
// names, and the fields the valueOf and constructor ops read.
const KEYS = ['a', 'b', 'name', 'lastDate', 'chats', '0', '1', '-', '', 'a/b', 'm~n', '~1', 'length',
    'constructor', 'prototype', 'toString', 'test', 'newDocument', 'value'] as const
const LEAVES = [null, true, false, 0, 1, -1, 3.5, '', 'text', '0', 'user'] as const

function makeValue(rand: () => number, depth: number): unknown {
    const r = rand()
    if (depth <= 0 || r < 0.3) return pick(rand, LEAVES)
    if (r < 0.6) return Array.from({ length: Math.floor(rand() * 4) }, () => makeValue(rand, depth - 1))
    const object: Record<string, unknown> = {}
    const count = Math.floor(rand() * 5)
    for (let k = 0; k < count; k++) object[pick(rand, KEYS)] = makeValue(rand, depth - 1)
    return object
}
function makeRoot(rand: () => number): any {
    const r = rand()
    // A few odd roots for applyValidatedPatch alone.
    if (r < 0.03) return makeValue(rand, 3)
    const root: Record<string, unknown> = {
        username: 'user',
        characters: Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) => ({
            chaId: `cha-${i}`,
            name: `character ${i}`,
            chats: Array.from({ length: Math.floor(rand() * 3) }, (_, j) => (rand() < 0.5
                ? { id: `chat-${j}`, _stub: true }
                : { id: `chat-${j}`, _stub: true, lastDate: j })),
            extra: makeValue(rand, 3),
        })),
        modules: [{ id: 'mod-0', lorebook: [] }],
    }
    for (let k = 0; k < 3; k++) root[pick(rand, KEYS)] = makeValue(rand, 3)
    return root
}

const escape = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')
// Every pointer that exists in `value`, escaped.
function pointers(value: unknown, prefix = '', out: string[] = []): string[] {
    out.push(prefix)
    if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value)) pointers((value as any)[key], `${prefix}/${escape(key)}`, out)
    }
    return out
}
function resolve(root: unknown, pointer: string): unknown {
    if (pointer === '') return root
    let value: any = root
    for (const raw of pointer.split('/').slice(1)) {
        if (value === null || typeof value !== 'object') return undefined
        const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
        if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined
        value = value[key]
    }
    return value
}

const ODD_SEGMENTS = ['-', '01', '', '1e0', '4294967296', 'length', 'missing', '99', '~', '~2', '~01', 'a/b',
    '__proto__', 'constructor', 'prototype', 'toString', 'test'] as const
function makePointer(rand: () => number, root: unknown): string {
    const existing = pointers(root)
    const base = pick(rand, existing)
    const r = rand()
    if (r < 0.4) return base
    if (r < 0.55) return `${base}/${pick(rand, ODD_SEGMENTS)}`
    if (r < 0.65 && base !== '') return `${base.slice(0, base.lastIndexOf('/'))}/${pick(rand, ODD_SEGMENTS)}`
    if (r < 0.72) return `${base}/${pick(rand, ODD_SEGMENTS)}/${pick(rand, KEYS)}`
    if (r < 0.77) return pick(rand, ['', '/', '//', 'noslash', 'a/b', '/__proto__/x', '/constructor/prototype', '/characters/0/constructor/prototype/x'])
    if (r < 0.85) {
        // Past the end of an array, or just at it.
        const arrays = existing.filter((pointer) => Array.isArray(resolve(root, pointer)))
        if (arrays.length > 0) {
            const array = pick(rand, arrays)
            return `${array}/${(resolve(root, array) as unknown[]).length + pick(rand, [0, 0, 1, 2])}`
        }
    }
    return `${base}/${escape(pick(rand, KEYS))}`
}

const OP_NAMES = ['add', 'replace', 'remove', 'test', 'move', 'copy'] as const
const ODD_OP_NAMES = ['_get', 'bogus', 'toString', 'valueOf', 'constructor', 'hasOwnProperty', '__proto__', '__lookupGetter__'] as const
function makeOp(rand: () => number, root: unknown): unknown {
    const r = rand()
    if (r < 0.02) return pick(rand, [null, 'op', [], 5, [{ op: 'add', path: '/a', value: 1 }]])
    const op: Op = {}
    const nameRoll = rand()
    if (nameRoll < 0.8) op.op = pick(rand, OP_NAMES)
    else if (nameRoll < 0.93) op.op = pick(rand, ODD_OP_NAMES)
    else if (nameRoll < 0.98) op.op = pick(rand, [['add'], ['test'], ['move'], 5, null, {}])
    const path = rand() < 0.97 ? makePointer(rand, root) : pick(rand, [5, null, undefined])
    op.path = path
    const valueRoll = rand()
    if (valueRoll < 0.4) op.value = makeValue(rand, 2)
    // Often the value at the path, so that a test op can pass.
    else if (valueRoll < 0.8) op.value = structuredClone((typeof path === 'string' ? resolve(root, path) : undefined) ?? makeValue(rand, 2))
    else if (valueRoll < 0.84) op.value = { nested: [1, undefined] }
    else if (valueRoll < 0.87) op.value = undefined
    if (op.op === 'move' || op.op === 'copy' || rand() < 0.1) {
        op.from = rand() < 0.95 ? makePointer(rand, root) : pick(rand, [5, null])
        // A move from the root puts the document inside itself. The module
        // assumes a JSON document, and on a cyclic one the library's own
        // JSON.stringify calls throw instead.
        if (op.from === '' && String(op.op) === 'move') op.from = '/username'
    }
    if (rand() < 0.08) op.test = pick(rand, [false, true, 0])
    if (rand() < 0.03) op.newDocument = makeValue(rand, 2)
    return op
}
function makePatch(rand: () => number, root: unknown): unknown {
    if (rand() < 0.01) return pick(rand, [null, {}, 'patch', { op: 'add', path: '/a', value: 1 }])
    return Array.from({ length: rand() < 0.5 ? 1 : 2 + Math.floor(rand() * 3) }, () => makeOp(rand, root))
}

function isJsonObject(value: unknown) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    return isDeepStrictEqual(JSON.parse(JSON.stringify(value)), value)
}

function compareOutcomes(where: string, ours: { result?: any, error?: any }, reference: { result?: any, error?: any }) {
    expect(!!ours.error, `${where}: ${firstLine(ours.error)} / ${firstLine(reference.error)}`).toBe(!!reference.error)
    if (reference.error) {
        const [a, b] = [ours.error, reference.error]
        expect(a.constructor, where).toBe(b.constructor)
        expect(a.name, where).toBe(b.name)
        expect(a.index, where).toBe(b.index)
        expect(firstLine(a), where).toBe(firstLine(b))
        expectSame(a.operation, b.operation, where)
        if (!(b instanceof JsonPatchError)) expect(a.message, where).toBe(b.message)
        expectNoDocument(a)
        return b.name
    }
    const [a, b] = [ours.result, reference.result]
    expectSame(a.newDocument, b.newDocument, where)
    expect(a.length, where).toBe(b.length)
    for (let i = 0; i < b.length; i++) expectSame(a[i], b[i], `${where} result ${i}`)
    return 'accepted'
}

describe('applyValidatedPatch against applyPatch (fuzz)', () => {
    it('accepts and rejects the same patches, at the same op with the same error', () => {
        const rand = mulberry32(0x5afe)
        const seen = new Map<string, number>()
        const note = (key: string) => seen.set(key, (seen.get(key) ?? 0) + 1)
        let root = makeRoot(rand)
        for (let n = 0; n < 6000; n++) {
            if (n % 20 === 0) root = makeRoot(rand)
            const patch = makePatch(rand, root)
            const where = `#${n} ${JSON.stringify(patch)?.slice(0, 400)}`
            const before = structuredClone(root)

            // Each apply mutates its own copy with its own ops.
            const referenceRoot = structuredClone(root)
            const reference = attempt(() => applyPatch(referenceRoot, structuredClone(patch), true))
            const oursRoot = structuredClone(root)
            const ours = attempt(() => applyValidatedPatch(oursRoot, structuredClone(patch)))
            note(compareOutcomes(where, ours, reference))
            if (reference.error?.index > 0) note('later op')
            // The ops before a failing one changed both copies alike, and the
            // walk itself changed nothing.
            expectSame(oursRoot, referenceRoot, where)

            // The /api/patch path, which leaves the root it is given alone.
            if (root !== null && typeof root === 'object' && !Array.isArray(root)) {
                const cow = attempt(() => applyPatchCopyOnWrite(root, structuredClone(patch)))
                compareOutcomes(`copy-on-write ${where}`, cow, reference)
                expectSame(root, before, where)
            }
            // Continue from an accepted root now and then, if it is still a
            // JSON object: a copy or move from an inherited name such as
            // /x/toString puts a function into it.
            const next = reference.result?.newDocument
            if (!reference.error && rand() < 0.3 && isJsonObject(next)) root = structuredClone(next)
        }
        // Every kind of rejection came up, plenty of accepted patches, and
        // rejections that name an op past the first (validator() errors
        // always carry index 0). A run gives about 970 accepted and 5,030
        // rejected, 260 of them with an index past 0.
        const expected = [
            'accepted', 'OPERATION_NOT_AN_OBJECT', 'OPERATION_OP_INVALID', 'OPERATION_PATH_INVALID',
            'OPERATION_FROM_REQUIRED', 'OPERATION_VALUE_REQUIRED', 'OPERATION_VALUE_CANNOT_CONTAIN_UNDEFINED',
            'OPERATION_PATH_CANNOT_ADD', 'OPERATION_PATH_UNRESOLVABLE', 'OPERATION_FROM_UNRESOLVABLE',
            'OPERATION_PATH_ILLEGAL_ARRAY_INDEX', 'OPERATION_VALUE_OUT_OF_BOUNDS', 'TEST_OPERATION_FAILED',
            'SEQUENCE_NOT_AN_ARRAY', 'TypeError',
        ]
        for (const key of expected) expect(seen.get(key) ?? 0, `${key}: ${JSON.stringify([...seen])}`).toBeGreaterThan(0)
        expect(seen.get('accepted')).toBeGreaterThan(700)
        expect(seen.get('later op')).toBeGreaterThan(150)
    }, 120_000)
})
