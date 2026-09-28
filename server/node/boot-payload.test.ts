/**
 * boot-payload.cjs: the /api/read payload as content-addressed segments.
 *
 * The oracle for every plan is encodeRisuSaveLegacy of the same root (what
 * /api/read sent before the planner), cross-checked against the ESM build of
 * msgpackr, which is a module instance of its own.
 */
import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { Packr as OraclePackr } from 'msgpackr'

const requireCjs = createRequire(import.meta.url)
const utils = requireCjs('./utils.cjs')
const {
    createBootPayloadPlanner,
    encodeBootHeader,
    parseHaveList,
    deriveBootCacheKey,
    ifNoneMatchIncludes,
    isTrueLoopbackRequest,
    MAX_HAVE_DIGESTS,
} = requireCjs('./boot-payload.cjs')
const { deepFreeze } = requireCjs('./chat-body-store.cjs')

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const oracle = new OraclePackr({ useRecords: false })
const MAGIC = Buffer.from(utils.magicHeader)

function planner(options: Record<string, unknown> = {}) {
    return createBootPayloadPlanner({ logger: quiet, ...options })
}

function planBytes(p: any, plan: any) {
    return Buffer.concat([plan.prefix, ...plan.segments.map((segment: any) => p.segmentBytes(segment))])
}

function expectPlanMatchesEncode(root: unknown, p = planner()) {
    const plan = p.planFor(root)
    const expected = Buffer.from(utils.encodeRisuSaveLegacy(root))
    expect(Buffer.concat([MAGIC, Buffer.from(oracle.encode(root))]).equals(expected)).toBe(true)
    const actual = planBytes(p, plan)
    if (!actual.equals(expected)) {
        let at = 0
        while (at < expected.length && actual[at] === expected[at]) at++
        throw new Error(`plan bytes differ at ${at} (${actual.length} vs ${expected.length})`)
    }
    expect(plan.total).toBe(expected.length)
    return plan
}

// A string of exactly n UTF-8 bytes, mostly Korean (3 bytes per syllable).
function utf8OfBytes(n: number) {
    return '가'.repeat(Math.floor(n / 3)) + 'a'.repeat(n % 3)
}

function rootWithKeys(n: number) {
    const root: Record<string, unknown> = {}
    for (let i = 0; i < n; i++) root[`k${i}`] = i % 3 === 0 ? `v${i}` : i % 3 === 1 ? i * 1000 : { i }
    return root
}

function character(i: number, extra: Record<string, unknown> = {}) {
    return {
        chaId: `cha-${i}`,
        name: `캐릭터 ${i}`,
        desc: 'x'.repeat(200 + (i % 7) * 50),
        chats: [{ id: `chat-${i}-0`, name: '', _stub: true, lastDate: 1727400000000 + i }],
        ...extra,
    }
}

function merkleFromManifest(prefix: Buffer, manifest: { digest: Buffer; len: number }[]) {
    const lenBuf = Buffer.alloc(4)
    const hash = createHash('sha256').update(Buffer.from([1])).update(prefix)
    for (const entry of manifest) {
        lenBuf.writeUInt32BE(entry.len)
        hash.update(entry.digest).update(lenBuf)
    }
    return `m1-${hash.digest('hex').slice(0, 40)}`
}

describe('plan bytes', () => {
    it('equal encodeRisuSaveLegacy for varied roots', () => {
        const strings = [31, 32, 255, 256, 65535, 65536].map(utf8OfBytes)
        expect(strings.map((s) => Buffer.byteLength(s))).toEqual([31, 32, 255, 256, 65535, 65536])

        const nullProto = Object.assign(Object.create(null), { b: 1, a: [2] })
        const cases: unknown[] = [
            {},
            rootWithKeys(1),
            rootWithKeys(15),
            rootWithKeys(16),
            rootWithKeys(17),
            { characters: [] },
            { characters: Array.from({ length: 15 }, (_, i) => character(i)) },
            { characters: Array.from({ length: 16 }, (_, i) => character(i)), modules: [] },
            { characters: Array.from({ length: 17 }, (_, i) => character(i)), modules: [{ id: 'm', lorebook: [] }] },
            {
                name: strings[0],
                characters: strings.map((s, i) => character(i, { desc: s })),
                modules: strings.map((s) => ({ id: s.slice(0, 3), text: s })),
                ...Object.fromEntries(strings.map((s, i) => [`s${i}`, s])),
            },
            {
                numbers: [0, 0.5, -0, 1e300, -1.5, 2 ** 53, -(2 ** 40), 65535, 65536, 2 ** 32, NaN, Infinity],
                big: BigInt(2) ** BigInt(60),
                negativeZero: -0,
                float: 0.1,
                nothing: null,
                yes: true,
                no: false,
                missing: undefined,
                characters: [character(0, { floats: [0.25, -0, 1e-7], big: 2 ** 60, flags: [true, false, null] })],
            },
            {
                emptyList: [],
                emptyObject: {},
                nested: { a: [], b: {}, c: [[], [{}], {}] },
                characters: [{}, { chats: [] }, { a: [[]], b: { c: {} } }],
                modules: [[], {}, [[]]],
            },
            JSON.parse('{"__proto__":{"x":1},"characters":[{"__proto__":{"y":2},"name":"p"}],"after":2}'),
            { hasOwnProperty: 'a string', characters: [{ hasOwnProperty: 'shadowed', v: 1 }], v: 2 },
            { 10: 'ten', 2: 'two', characters: [character(1)], z: 'last' },
            // Elements that are not plain objects, and a characters that is not an array.
            { characters: [null, 'text', 42, [1, 2], nullProto, new Date(1727400000000), Uint8Array.from([1, 2, 3])] },
            { characters: { 0: character(0) }, modules: 'not a list' },
            // msgpackr takes another branch for these roots: encoded whole.
            { constructor: 'plain data', characters: [character(0)] },
            Object.assign(Object.create(null), { characters: [character(0)], b: 1 }),
            // Values of other classes at the root.
            { when: new Date(1727400000000), map: new Map([['k', 1]]), bytes: Uint8Array.from([1, 2]), characters: [] },
            deepFreeze({ characters: [character(0), character(1)], modules: [{ id: 'frozen' }], globalNote: 'frozen' }),
        ]
        for (const root of cases) expectPlanMatchesEncode(root)
    })

    it('equal encodeRisuSaveLegacy for 300 random roots, planned one after another', () => {
        let seed = 20260928
        const rand = () => {
            seed = (seed + 0x6d2b79f5) | 0
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296
        }
        const leaves = [null, undefined, true, false, 0, -0, 1.5, -33, 2 ** 40, 'a', '가나다', 'x'.repeat(40), utf8OfBytes(300), NaN]
        const value = (depth: number): unknown => {
            const r = rand()
            if (depth > 3 || r < 0.5) return leaves[Math.floor(rand() * leaves.length)]
            if (r < 0.75) return Array.from({ length: Math.floor(rand() * 20) }, () => value(depth + 1))
            const o: Record<string, unknown> = {}
            for (let i = Math.floor(rand() * 20); i > 0; i--) o[['id', 'name', '0', '12', 'chats', `k${i}`][Math.floor(rand() * 6)]] = value(depth + 1)
            return o
        }
        const p = planner()
        let previous: Record<string, unknown> = {}
        for (let n = 0; n < 300; n++) {
            // Half the roots share most of their objects with the previous one.
            const root: Record<string, unknown> = rand() < 0.5 ? { ...previous } : {}
            for (let i = Math.floor(rand() * 6); i > 0; i--) root[`r${Math.floor(rand() * 8)}`] = value(1)
            const list = (key: string) => {
                const old = Array.isArray(root[key]) ? root[key] as unknown[] : []
                const next = old.slice(0, Math.floor(rand() * (old.length + 1)))
                for (let i = Math.floor(rand() * 5); i > 0; i--) next.push(rand() < 0.9 ? value(1) : leaves[Math.floor(rand() * leaves.length)])
                return next
            }
            if (rand() < 0.8) root.characters = list('characters')
            if (rand() < 0.6) root.modules = list('modules')
            if (rand() < 0.3) root.personas = Array.from({ length: 70 }, (_, i) => ({ i, pad: 'p'.repeat(1000 + Math.floor(rand() * 100)) }))
            expectPlanMatchesEncode(root, p)
            previous = root
        }
        expect(p.disabled()).toBeNull()
    })

    it('equal encodeRisuSaveLegacy for 70,000 characters (array32) and split root arrays', () => {
        const root = {
            characters: Array.from({ length: 70000 }, (_, i) => ({ chaId: `c${i}`, v: i })),
            personas: Array.from({ length: 80 }, (_, i) => ({ id: `p${i}`, note: 'n'.repeat(2000) })),
            botPresets: [{ id: 'small' }],
            characterOrder: Array.from({ length: 1000 }, (_, i) => `c${i}`),
        }
        const plan = expectPlanMatchesEncode(root)
        // characters head + 70,000 elements, personas head + 80, and one pair each for the others.
        expect(plan.segments.length).toBe(1 + 70000 + 1 + 80 + 2)
        expect(plan.segments[0].len).toBe(Buffer.byteLength('characters') + 1 + 5)
    })

    it('planning (with its self-test) hands msgpackr scratch back after a large segment', () => {
        const big = { characters: [{ text: 'x'.repeat(3 * 1024 * 1024) }], other: 'y'.repeat(2 * 1024 * 1024) }
        const p = planner()
        const plan = p.planFor(big)
        expect(p.stats().selfTest).toMatchObject({ passed: true })
        // The next small encode starts in a fresh, small scratch: its view's
        // backing buffer is not the multi-MB one the large encodes grew.
        const view = new (requireCjs('msgpackr').Packr)({ useRecords: false }).encode({ a: 1 })
        expect(view.buffer.byteLength).toBeLessThan(1024 * 1024)
        expect(planBytes(p, plan).equals(utils.encodeRisuSaveLegacyBuffer(big))).toBe(true)
    })
})

describe('etag', () => {
    it('is equal for deep-equal roots built from different objects', () => {
        const build = () => ({
            characters: [character(0), character(1)],
            modules: [{ id: 'm1', text: 'module' }],
            globalNote: 'note',
            characterOrder: ['cha-1', 'cha-0'],
        })
        const p = planner()
        const a = p.planFor(build())
        const b = p.planFor(build())
        expect(a.etag).toMatch(/^m1-[0-9a-f]{40}$/)
        expect(b.etag).toBe(a.etag)
        expect(planner().planFor(build()).etag).toBe(a.etag)
    })

    it('changes when one segment, the key order or an array order changes', () => {
        const p = planner()
        const base = { characters: [character(0), character(1)], modules: [{ id: 'm' }], globalNote: 'note', order: [1, 2] }
        const etag = p.planFor(base).etag
        const variants = [
            { ...base, globalNote: 'changed' },
            { ...base, characters: [base.characters[0], { ...base.characters[1], name: 'renamed' }] },
            { ...base, characters: [base.characters[1], base.characters[0]] },
            { ...base, order: [2, 1] },
            { globalNote: base.globalNote, characters: base.characters, modules: base.modules, order: base.order },
            { ...base, extra: null },
        ]
        const etags = new Set([etag, ...variants.map((root) => p.planFor(root).etag)])
        expect(etags.size).toBe(variants.length + 1)
    })

    it('is recomputed from the manifest: sha256(0x01 ‖ prefix ‖ Σ digest ‖ u32be len)', () => {
        const plan = planner().planFor({ characters: [character(0)], globalNote: 'n' })
        const manifest = plan.segments.map((s: any) => ({ digest: Buffer.from(s.digest, 'latin1'), len: s.len }))
        expect(merkleFromManifest(plan.prefix, manifest)).toBe(plan.etag)
    })
})

describe('memoized planning', () => {
    it('a root that shares its elements encodes only the new ones', () => {
        const p = planner()
        const characters = Array.from({ length: 50 }, (_, i) => character(i))
        const modules = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, text: 'm'.repeat(100) }))
        const first = { characters, modules, globalNote: 'a', settings: { a: 1 } }
        p.planFor(first)
        const before = p.stats().encodedSegments

        // A patch of characters[7]: new array, one new element, the rest shared.
        const nextCharacters = characters.slice()
        nextCharacters[7] = { ...characters[7], chats: [{ ...characters[7].chats[0], lastDate: 1 }] }
        const second = { ...first, characters: nextCharacters }
        const plan = expectPlanMatchesEncode(second, p)
        // The new element and the two heads (encoded with every plan);
        // expectPlanMatchesEncode's segmentBytes calls are not counted.
        expect(p.stats().encodedSegments - before).toBe(3)
        expect(plan.segments.filter((s: any) => s.kind === 'value').length).toBe(60)

        // A root scalar change: the new pair's key and value, and the two heads.
        const before2 = p.stats().encodedSegments
        p.planFor({ ...second, globalNote: 'b' })
        expect(p.stats().encodedSegments - before2).toBe(4)
        // The same root again is a memo hit.
        const before3 = p.stats().encodedSegments
        expect(p.planFor(second)).toBe(plan)
        expect(p.stats().encodedSegments).toBe(before3)
    })

    it('reset forgets every memo', () => {
        const p = planner()
        const root = { characters: [character(0)], globalNote: 'n' }
        const plan = p.planFor(root)
        p.reset()
        const before = p.stats().encodedSegments
        const again = p.planFor(root)
        expect(again).not.toBe(plan)
        expect(again.etag).toBe(plan.etag)
        expect(p.stats().encodedSegments).toBeGreaterThan(before)
    })
})

describe('split policy', () => {
    const kinds = (plan: any) => plan.segments.map((s: any) => s.kind).join(',')

    it('splits characters and modules always, whatever their content', () => {
        const plan = planner().planFor({ characters: [1, 'a'], modules: [] })
        expect(kinds(plan)).toBe('raw,value,value,raw')
    })

    it('splits another root array only when all elements are objects, >= 64KB in total and >= 1KB on average', () => {
        const big = (n: number, size: number) => Array.from({ length: n }, (_, i) => ({ i, pad: 'p'.repeat(size) }))
        const p = planner()
        expect(kinds(p.planFor({ personas: big(40, 2000) }))).toBe(`raw,${Array(40).fill('value').join(',')}`)
        // Under 64KB in total.
        expect(kinds(p.planFor({ personas: big(20, 2000) }))).toBe('pair')
        // 64KB and more, but under 1KB on average.
        expect(kinds(p.planFor({ personas: big(200, 500) }))).toBe('pair')
        // Not every element is an object.
        expect(kinds(p.planFor({ personas: [...big(40, 2000), 'x'] }))).toBe('pair')
        expect(kinds(p.planFor({ personas: [...big(40, 2000), null] }))).toBe('pair')
        expect(kinds(p.planFor({ characterOrder: Array.from({ length: 5000 }, (_, i) => `id-${i}-${'x'.repeat(30)}`) }))).toBe('pair')
        expect(kinds(p.planFor({ personas: [] }))).toBe('pair')
        expect(kinds(p.planFor({ personas: { 0: {} } }))).toBe('pair')
    })
})

describe('mutation detection', () => {
    it('segmentBytes throws BOOT_SEGMENT_MUTATED after an in-place edit, and the planner stays disabled', () => {
        const reports: string[] = []
        const p = planner({ onMutation: (detail: string) => reports.push(detail) })
        const root = { characters: [character(0), character(1)], globalNote: 'n' }
        const plan = p.planFor(root)
        root.characters[1].name = 'changed in place'
        expect(p.segmentBytes(plan.segments[1]).length).toBe(plan.segments[1].len)
        expect(() => p.segmentBytes(plan.segments[2])).toThrow(expect.objectContaining({ code: 'BOOT_SEGMENT_MUTATED' }))
        expect(reports).toHaveLength(1)
        expect(p.disabled()).toMatch(/BOOT_SEGMENT_MUTATED/)
        expect(p.tryPlan({ globalNote: 'another root' })).toBeNull()
        expect(() => p.planFor(root)).toThrow(expect.objectContaining({ code: 'BOOT_DISABLED' }))
        expect(() => p.segmentBytes(plan.segments[0])).toThrow(expect.objectContaining({ code: 'BOOT_DISABLED' }))
        expect(p.stats().mutations).toBe(1)
    })

    it('disable() takes effect at once', () => {
        const p = planner()
        const root = { characters: [character(0)] }
        const plan = p.planFor(root)
        p.disable('test')
        expect(p.disabled()).toBe('test')
        expect(p.tryPlan(root)).toBeNull()
        expect(() => p.segmentBytes(plan.segments[0])).toThrow(expect.objectContaining({ code: 'BOOT_DISABLED' }))
    })
})

describe('self-test', () => {
    it('disables the planner when the segment encoder diverges from the whole encode', () => {
        const errors: string[] = []
        const diverging = (value: unknown) => {
            const bytes = utils.encodeMsgpackOwned(value)
            // One byte more after an element than the whole encode writes.
            return typeof value === 'object' && value !== null && 'pad' in value ? Buffer.concat([bytes, Buffer.from([0xc0])]) : bytes
        }
        const p = planner({ encode: diverging, logger: { ...quiet, error: (m: string) => errors.push(m) } })
        const root = { characters: [{ pad: 1 }], globalNote: 'n' }
        expect(p.tryPlan(root)).toBeNull()
        expect(p.disabled()).toMatch(/self-test/)
        expect(p.stats().selfTest).toMatchObject({ passed: false })
        expect(errors.join('\n')).toMatch(/disabled/)
    })

    it('runs until a root with element segments passes, then never again', () => {
        let wholeEncodes = 0
        const encodeWhole = (root: unknown) => {
            wholeEncodes++
            return utils.encodeRisuSaveLegacyBuffer(root)
        }
        const p = planner({ encodeWhole })
        p.planFor({})
        p.planFor({ characters: [], globalNote: 'a' })
        expect(wholeEncodes).toBe(2)
        p.planFor({ characters: [character(0)], globalNote: 'a' })
        expect(wholeEncodes).toBe(3)
        expect(p.stats()).toMatchObject({ selfTested: true, selfTest: { passed: true } })
        p.planFor({ characters: [character(1)], globalNote: 'b' })
        p.planFor({ globalNote: 'c' })
        expect(wholeEncodes).toBe(3)
    })

    it('a planning error disables the planner (the whole encode stays the reference)', () => {
        const p = planner()
        const wide: Record<string, number> = {}
        for (let i = 0; i < 0x10000; i++) wide[`k${i}`] = i
        expect(p.tryPlan(wide)).toBeNull()
        expect(p.disabled()).toMatch(/planning failed/)
    })
})

describe('parseHaveList', () => {
    it('reads concatenated 16-byte digests', () => {
        expect(parseHaveList(Buffer.alloc(0)).size).toBe(0)
        expect(parseHaveList(undefined).size).toBe(0)
        expect(parseHaveList({}).size).toBe(0)
        const digests = [Buffer.alloc(16, 1), Buffer.alloc(16, 0xff), Buffer.alloc(16, 1)]
        const have = parseHaveList(Buffer.concat(digests))
        expect(have.size).toBe(2)
        expect(have.has(Buffer.alloc(16, 0xff).toString('latin1'))).toBe(true)
    })

    it('answers 400 for a length that is not a multiple of 16, 413 over the cap', () => {
        expect(() => parseHaveList(Buffer.alloc(15))).toThrow(expect.objectContaining({ status: 400 }))
        expect(() => parseHaveList(Buffer.alloc(33))).toThrow(expect.objectContaining({ status: 400 }))
        expect(parseHaveList(Buffer.alloc(16 * MAX_HAVE_DIGESTS)).size).toBe(1)
        expect(() => parseHaveList(Buffer.alloc(16 * (MAX_HAVE_DIGESTS + 1)))).toThrow(expect.objectContaining({ status: 413 }))
    })
})

class MockResponse extends EventEmitter {
    chunks: Buffer[] = []
    ended = false
    destroyed = false
    writableEnded = false
    accept: () => boolean = () => true
    write(chunk: Buffer) {
        this.chunks.push(Buffer.from(chunk))
        return this.accept()
    }
    end() {
        this.ended = true
        this.writableEnded = true
    }
}

function streamFixture() {
    const p = planner()
    const root = {
        characters: Array.from({ length: 40 }, (_, i) => character(i, { pad: 'q'.repeat(3000 + i) })),
        modules: [{ id: 'm', text: 'z'.repeat(200 * 1024) }],
        globalNote: 'note',
    }
    const plan = p.planFor(root)
    const expected = Buffer.from(utils.encodeRisuSaveLegacy(root))
    return { p, root, plan, expected }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('streamSegments', () => {
    it('writes the payload in writes of at least 64KB and ends the response', async () => {
        const { p, plan, expected } = streamFixture()
        const res = new MockResponse()
        const result = await p.streamSegments(res, plan, { head: plan.prefix })
        expect(result).toMatchObject({ completed: true, bytes: expected.length, segments: plan.segments.length })
        expect(res.ended).toBe(true)
        expect(Buffer.concat(res.chunks).equals(expected)).toBe(true)
        expect(res.chunks.length).toBeLessThan(plan.segments.length / 4)
        for (const chunk of res.chunks.slice(0, -1)) expect(chunk.length).toBeGreaterThanOrEqual(64 * 1024)
        expect(res.listenerCount('drain')).toBe(0)
        expect(res.listenerCount('close')).toBe(0)
    })

    it('leaves out the segments in omit', async () => {
        const { p, plan } = streamFixture()
        const omit = new Set([plan.segments[3].digest, plan.segments[41].digest])
        const res = new MockResponse()
        const head = Buffer.from('HEAD')
        const result = await p.streamSegments(res, plan, { head, omit })
        const expected = Buffer.concat([head, ...plan.segments
            .filter((s: any) => !omit.has(s.digest))
            .map((s: any) => p.segmentBytes(s))])
        expect(Buffer.concat(res.chunks).equals(expected)).toBe(true)
        expect(result.segments).toBe(plan.segments.length - 2)
    })

    it('waits for drain after a refused write', async () => {
        const { p, plan, expected } = streamFixture()
        const res = new MockResponse()
        res.accept = () => false
        let done = false
        const streaming = p.streamSegments(res, plan, { head: plan.prefix }).then((r: any) => { done = true; return r })
        let drains = 0
        while (!done) {
            await tick()
            await tick()
            // Nothing more is written until the refused write drains.
            expect(res.chunks.length).toBeLessThanOrEqual(drains + 1)
            res.emit('drain')
            drains++
            if (drains > 10000) throw new Error('stream did not finish')
        }
        const result = await streaming
        expect(result.completed).toBe(true)
        expect(Buffer.concat(res.chunks).equals(expected)).toBe(true)
        expect(res.listenerCount('drain')).toBe(0)
    })

    it('stops when the response closes', async () => {
        const { p, plan, expected } = streamFixture()
        const res = new MockResponse()
        res.accept = () => false
        const streaming = p.streamSegments(res, plan, { head: plan.prefix })
        await tick()
        expect(res.chunks.length).toBe(1)
        res.destroyed = true
        res.emit('close')
        const result = await streaming
        expect(result.completed).toBe(false)
        expect(res.ended).toBe(false)
        expect(res.chunks.length).toBe(1)
        expect(result.bytes).toBeLessThan(expected.length)
        expect(res.listenerCount('close')).toBe(0)
    })

    it('rejects with BOOT_SEGMENT_MUTATED when a segment changed after planning', async () => {
        const { p, root, plan } = streamFixture()
        root.characters[30].name = 'changed'
        const res = new MockResponse()
        await expect(p.streamSegments(res, plan, { head: plan.prefix })).rejects.toMatchObject({ code: 'BOOT_SEGMENT_MUTATED' })
        expect(res.ended).toBe(false)
        expect(p.disabled()).toBeTruthy()
    })
})

// The /api/db/boot body, read back the way a client reads it.
function parseBootBody(body: Buffer) {
    let at = 0
    const take = (n: number) => { const out = body.subarray(at, at + n); at += n; if (out.length !== n) throw new Error('truncated'); return out }
    expect(take(4).toString('ascii')).toBe('PRB1')
    const flags = take(1)[0]
    let keyId: string | null = null
    let key: Buffer | null = null
    if (flags & 1) {
        keyId = take(take(1)[0]).toString('ascii')
        key = Buffer.from(take(take(1)[0]))
    }
    const prefix = Buffer.from(take(take(4).readUInt32BE(0)))
    const count = take(4).readUInt32BE(0)
    const manifest = []
    for (let i = 0; i < count; i++) {
        const entry = take(21)
        manifest.push({ digest: Buffer.from(entry.subarray(0, 16)), len: entry.readUInt32BE(16), included: entry[20] === 1 })
    }
    const segments = manifest.map((entry) => (entry.included ? Buffer.from(take(entry.len)) : null))
    expect(at).toBe(body.length)
    return { flags, keyId, key, prefix, manifest, segments }
}

describe('encodeBootHeader', () => {
    it('frames the manifest and the included segments', async () => {
        const { p, plan, expected } = streamFixture()
        const cacheKey = deriveBootCacheKey('secret')
        const omit = new Set([plan.segments[5].digest, plan.segments[6].digest])
        const framed = encodeBootHeader(plan, { omit, key: cacheKey })
        const res = new MockResponse()
        await p.streamSegments(res, plan, { head: framed.header, omit })
        const body = Buffer.concat(res.chunks)
        const parsed = parseBootBody(body)
        expect(parsed.flags).toBe(1)
        expect(parsed.keyId).toBe(cacheKey.keyId)
        expect(parsed.key!.equals(cacheKey.key)).toBe(true)
        expect(parsed.prefix.equals(plan.prefix)).toBe(true)
        expect(parsed.manifest.filter((e) => !e.included)).toHaveLength(2)
        expect(framed.includedSegments).toBe(plan.segments.length - 2)
        expect(framed.includedBytes).toBe(plan.total - plan.prefix.length - plan.segments[5].len - plan.segments[6].len)
        expect(merkleFromManifest(parsed.prefix, parsed.manifest)).toBe(plan.etag)
        // Filled from the "cache", the parts assemble to the /api/read payload.
        const cached = new Map(plan.segments.map((s: any) => [s.digest, p.segmentBytes(s)]))
        const assembled = Buffer.concat([parsed.prefix, ...parsed.manifest.map((e, i) => parsed.segments[i] ?? cached.get(e.digest.toString('latin1')))])
        expect(assembled.equals(expected)).toBe(true)
        for (const [i, e] of parsed.manifest.entries()) {
            if (parsed.segments[i]) expect(createHash('sha256').update(parsed.segments[i]!).digest().subarray(0, 16).equals(e.digest)).toBe(true)
        }
    })

    it('has no key block without a key', async () => {
        const p = planner()
        const plan = p.planFor({ globalNote: 'n', characters: [character(0)] })
        const { header, includedBytes } = encodeBootHeader(plan)
        const res = new MockResponse()
        await p.streamSegments(res, plan, { head: header })
        const body = Buffer.concat(res.chunks)
        expect(body.length).toBe(header.length + includedBytes)
        const parsed = parseBootBody(body)
        expect(parsed.flags).toBe(0)
        expect(parsed.keyId).toBeNull()
        expect(Buffer.concat([parsed.prefix, ...parsed.segments.map((s) => s!)]).equals(utils.encodeRisuSaveLegacyBuffer({ globalNote: 'n', characters: [character(0)] }))).toBe(true)
    })
})

describe('request helpers', () => {
    it('deriveBootCacheKey: HMAC-SHA256(secret, info) and the first 16 hex digits of its sha256', () => {
        const { key, keyId } = deriveBootCacheKey('abc')
        expect(key.length).toBe(32)
        expect(keyId).toMatch(/^[0-9a-f]{16}$/)
        expect(deriveBootCacheKey('abc').key.equals(key)).toBe(true)
        expect(deriveBootCacheKey('abd').keyId).not.toBe(keyId)
        expect(keyId).toBe(createHash('sha256').update(key).digest('hex').slice(0, 16))
    })

    it('ifNoneMatchIncludes accepts the raw, quoted and weak forms, in a list', () => {
        const etag = 'm1-0123'
        expect(ifNoneMatchIncludes('m1-0123', etag)).toBe(true)
        expect(ifNoneMatchIncludes('"m1-0123"', etag)).toBe(true)
        expect(ifNoneMatchIncludes('W/"m1-0123"', etag)).toBe(true)
        expect(ifNoneMatchIncludes('"x", W/"m1-0123"', etag)).toBe(true)
        expect(ifNoneMatchIncludes('"m1-0124"', etag)).toBe(false)
        expect(ifNoneMatchIncludes('*', etag)).toBe(false)
        expect(ifNoneMatchIncludes(undefined, etag)).toBe(false)
    })

    it('isTrueLoopbackRequest: loopback address, no forwarding header, loopback Host', () => {
        const req = (remoteAddress: string, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers })
        expect(isTrueLoopbackRequest(req('127.0.0.1', { host: '127.0.0.1:6001' }))).toBe(true)
        expect(isTrueLoopbackRequest(req('::1', { host: 'localhost' }))).toBe(true)
        expect(isTrueLoopbackRequest(req('::ffff:127.0.0.1', { host: '[::1]:6001' }))).toBe(true)
        expect(isTrueLoopbackRequest(req('192.168.0.2', { host: '127.0.0.1:6001' }))).toBe(false)
        expect(isTrueLoopbackRequest(req('127.0.0.1', { host: 'laptop.tailnet.ts.net' }))).toBe(false)
        expect(isTrueLoopbackRequest(req('127.0.0.1', { host: 'localhost:6001', 'x-forwarded-for': '100.64.0.2' }))).toBe(false)
        expect(isTrueLoopbackRequest(req('127.0.0.1', { host: 'localhost:6001', forwarded: 'for=100.64.0.2' }))).toBe(false)
        expect(isTrueLoopbackRequest(req('127.0.0.1', {}))).toBe(false)
    })
})
