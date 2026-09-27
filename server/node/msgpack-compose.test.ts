import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
// The ESM build of msgpackr is a separate module instance (its own scratch
// and extension registry), so it is an oracle independent of utils.cjs.
import { Packr as OraclePackr } from 'msgpackr'

const requireCjs = createRequire(import.meta.url)
const {
    isComposableObject,
    isComposableArray,
    forEachOwnKey,
    mapHeader,
    arrayHeader,
    composeEncode,
    buildCanarySample,
    runCanary,
} = requireCjs('./msgpack-compose.cjs')
const { Packr: CjsPackr } = requireCjs('msgpackr')

const oracle = new OraclePackr({ useRecords: false })
const cjsPackr = new CjsPackr({ useRecords: false })
const oracleEncode = (value: unknown) => Buffer.from(oracle.encode(value))

function expectComposedEqualsPackr(value: unknown, maxDepth = Infinity) {
    const expected = oracleEncode(value)
    expect(Buffer.from(cjsPackr.encode(value)).equals(expected)).toBe(true)
    const composed = composeEncode(value, { maxDepth })
    if (!composed.equals(expected)) {
        let at = 0
        while (at < expected.length && composed[at] === expected[at]) at++
        throw new Error(`composed bytes differ at ${at} (${composed.length} vs ${expected.length})`)
    }
}

// Seeded PRNG so a failure reproduces.
function mulberry32(seed: number) {
    return () => {
        seed |= 0
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const STRINGS = [
    '', 'a', 'name', '가', '가나다', '🙂', 'x🙂y',
    'a'.repeat(31), 'a'.repeat(32), 'a'.repeat(63), 'a'.repeat(64),
    'a'.repeat(255), 'a'.repeat(256), '가'.repeat(10), '가'.repeat(11), '가'.repeat(85), '가'.repeat(86),
    // Lone surrogates, below and above the 64-unit switch to Buffer#utf8Write.
    '\ud800', 'ab\udc00', '\ud800'.repeat(70),
    '{{inlay::abc}}', 'line\nbreak', '~1/~0',
]
const NUMBERS = [
    0, 1, 31, 32, 127, 128, 255, 256, 65535, 65536, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 40,
    Number.MAX_SAFE_INTEGER, 2 ** 53 + 2, 2 ** 64, -1, -32, -33, -128, -129, -32768, -32769, -(2 ** 31), -(2 ** 31) - 1,
    -(2 ** 40), 0.5, 0.1, 1.5, -2.25, 1e-7, 1e300, 3.4028234663852886e38, -0, NaN, Infinity, -Infinity,
]
const KEYS = ['a', 'b', 'name', 'id', 'chats', '0', '1', '10', '2', '4294967295', '', '가', 'x/y', 'x~y', 'constructorish']

function randomLeaf(rand: () => number): unknown {
    const r = rand()
    if (r < 0.3) return STRINGS[Math.floor(rand() * STRINGS.length)]
    if (r < 0.6) return NUMBERS[Math.floor(rand() * NUMBERS.length)]
    if (r < 0.7) return rand() < 0.5
    if (r < 0.78) return null
    if (r < 0.82) return undefined
    if (r < 0.85) return BigInt(Math.floor(rand() * 2 ** 40)) - 2n ** 39n
    if (r < 0.87) return new Date(1727400000000 + Math.floor(rand() * 1e6))
    if (r < 0.89) return new Map([['k', 1], ['j', [2]]])
    if (r < 0.91) return Uint8Array.from([1, 2, 3])
    if (r < 0.93) return Object.assign(Object.create(null), { b: 1, a: 'x' })
    if (r < 0.95) return { constructor: 'own key', v: 1 }
    if (r < 0.97) return new (class Thing { a = 1; b = [2] })()
    return Object.assign(Object.create({ inherited: 'enumerable' }), { own: 1, hasOwnProperty: 'shadowed' })
}

// Containers get rarer with depth and wide ones are rare, so a value stays
// in the low thousands of nodes.
const SIZES = [0, 1, 1, 2, 2, 3, 3, 4, 15, 16, 17]
function randomValue(rand: () => number, depth: number): unknown {
    const r = rand()
    if (depth <= 0 || r < 0.25 + 0.12 * (5 - depth)) return randomLeaf(rand)
    if (rand() < 0.5) {
        const sizes = SIZES
        const size = sizes[Math.floor(rand() * sizes.length)]
        const obj: Record<string, unknown> = {}
        for (let i = 0; i < size; i++) {
            const key = rand() < 0.5 ? KEYS[Math.floor(rand() * KEYS.length)] : `k${Math.floor(rand() * 40)}`
            obj[key] = randomValue(rand, depth - 1)
        }
        if (rand() < 0.08) {
            // An own `__proto__` data property, as JSON.parse creates it.
            Object.defineProperty(obj, '__proto__', { value: randomValue(rand, depth - 1), enumerable: true, writable: true, configurable: true })
        }
        if (rand() < 0.05) obj.hasOwnProperty = 'a string, not the method'
        return obj
    }
    const length = SIZES[Math.floor(rand() * SIZES.length)]
    return Array.from({ length }, () => randomValue(rand, depth - 1))
}

function realShapedCharacter(i: number) {
    return {
        name: `캐릭터 ${i}`,
        image: `assets/${'a'.repeat(64)}.png`,
        firstMessage: '안녕하세요. '.repeat(40),
        desc: 'Description with {{user}} and <b>markup</b>. '.repeat(20),
        notes: '',
        chats: Array.from({ length: 3 + (i % 5) }, (_, j) => ({
            id: `chat-${i}-${j}`, name: j === 0 ? '' : `대화 ${j}`, _stub: true, lastDate: 1727400000000 + j, folderId: j % 2 ? null : 'folder-1',
        })),
        chatFolders: [{ id: 'folder-1', name: 'Folder', color: '', folded: false }],
        chatPage: 0,
        viewScreen: 'none',
        bias: [['token', -5]],
        emotionImages: [['happy', 'assets/happy.png'], ['sad', 'assets/sad.png']],
        globalLore: Array.from({ length: 20 }, (_, k) => ({
            key: `key${k}`, comment: `entry ${k}`, content: '로어 내용 '.repeat(30), mode: 'normal',
            insertorder: 100 + k, alwaysActive: k === 0, secondkey: '', selective: false,
        })),
        chaId: `cha-${i}`,
        type: 'character',
        customscript: [{ comment: 'regex', in: '\\*(.+?)\\*', out: '<i>$1</i>', type: 'editdisplay', flag: 'g', ableFlag: true }],
        utilityBot: false,
        exampleMessage: '',
        creatorNotes: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        alternateGreetings: ['인사 1', '인사 2'],
        tags: ['tag-a', 'tag-b'],
        creator: '',
        characterVersion: '1.0',
        personality: '',
        scenario: '',
        firstMsgIndex: -1,
        loreSettings: { tokenBudget: 800, scanDepth: 5, recursiveScanning: true, fullWordMatching: false },
        additionalData: { tag: [], creator: '', character_version: '' },
        ttsMode: '',
        voicevoxConfig: { speaker: '', SPEED_SCALE: 1, PITCH_SCALE: 0, INTONATION_SCALE: 1 },
        sdData: [['always', 'solo, 1girl'], ['negative', '']],
        additionalAssetManifest: { id: 'f'.repeat(64), version: 1, count: 12, sha256: 'e'.repeat(64), ownerKind: 'character', ownerId: `cha-${i}` },
        lastInteraction: 1727400000000 + i,
        extentions: { risuai: { backgroundHTML: '<div>'.repeat(10) }, depth_prompt: { depth: 4, prompt: '' } },
        triggerscript: [],
        lowLevelAccess: false,
        depth_prompt: { depth: 0, prompt: '' },
    }
}

function realShapedModule(i: number) {
    return {
        name: `모듈 ${i}`,
        description: 'module',
        lorebook: Array.from({ length: 8 }, (_, k) => ({ key: `m${k}`, content: 'x'.repeat(200), comment: '', mode: 'normal', insertorder: k, alwaysActive: false, secondkey: '', selective: false })),
        regex: [{ comment: 'r', in: 'a', out: 'b', type: 'editoutput', ableFlag: false }],
        trigger: [],
        id: `mod-${i}`,
        lowLevelAccess: false,
        hideIcon: false,
        ...(i % 2 ? { assetManifest: { id: 'd'.repeat(64), version: 1, count: 3, sha256: 'c'.repeat(64), ownerKind: 'module', ownerId: `mod-${i}` } } : {}),
    }
}

function realShapedRoot() {
    const root: Record<string, unknown> = {}
    for (let i = 0; i < 200; i++) root[`setting${i}`] = i % 3 === 0 ? `value ${i}` : i % 3 === 1 ? i * 1.5 : i % 2 === 0
    root.characters = Array.from({ length: 20 }, (_, i) => realShapedCharacter(i))
    root.modules = Array.from({ length: 17 }, (_, i) => realShapedModule(i))
    root.personas = [{ name: 'Default', icon: '', personaPrompt: '', id: 'p0' }]
    root.botPresets = [{ id: 'bp0', name: 'Preset', mainPrompt: 'x'.repeat(2000), temperature: 80 }]
    root.characterOrder = Array.from({ length: 20 }, (_, i) => `cha-${i}`)
    root.pluginCustomStorage = {}
    root.nodeOnlyArchivedCharacters = [{ chaId: 'arch-1', name: 'Archived', _archived: true }]
    return root
}

describe('msgpack-compose', () => {
    it('is built against the pinned msgpackr', () => {
        const installed = JSON.parse(readFileSync(join(dirname(requireCjs.resolve('msgpackr')), '..', 'package.json'), 'utf8'))
        expect(installed.version).toBe('1.11.9')
    })

    it('predicates follow msgpackr dispatch (constructor === Object / Array)', () => {
        expect(isComposableObject({})).toBe(true)
        expect(isComposableObject(JSON.parse('{"__proto__":1}'))).toBe(true)
        expect(isComposableObject({ hasOwnProperty: 'x' })).toBe(true)
        expect(isComposableObject(Object.create({ inherited: 1 }))).toBe(true)
        expect(isComposableObject(Object.create(null))).toBe(false)
        expect(isComposableObject({ constructor: 'x' })).toBe(false)
        expect(isComposableObject(new (class A {})())).toBe(false)
        expect(isComposableObject(new Date())).toBe(false)
        expect(isComposableObject(new Map())).toBe(false)
        expect(isComposableObject(Buffer.from([1]))).toBe(false)
        expect(isComposableObject([])).toBe(false)
        expect(isComposableObject(null)).toBe(false)
        expect(isComposableArray([])).toBe(true)
        expect(isComposableArray(new (class L extends Array {})())).toBe(false)
        expect(isComposableArray(Uint8Array.from([1]))).toBe(false)
        expect(isComposableArray({ length: 0 })).toBe(false)
    })

    it('forEachOwnKey yields msgpackr key order and filter', () => {
        const keys = (obj: object) => { const out: string[] = []; forEachOwnKey(obj, (k: string) => out.push(k)); return out }
        expect(keys({ b: 1, 2: 2, a: 3, 1: 4 })).toEqual(['1', '2', 'b', 'a'])
        const inherited = Object.assign(Object.create({ inherited: 1 }), { own: 2 })
        expect(keys(inherited)).toEqual(['own'])
        // With an own non-function hasOwnProperty msgpackr stops filtering.
        const unfiltered = Object.assign(Object.create({ inherited: 1 }), { own: 2, hasOwnProperty: 'x' })
        expect(keys(unfiltered)).toEqual(['own', 'hasOwnProperty', 'inherited'])
        expectComposedEqualsPackr({ wrap: unfiltered })
        expectComposedEqualsPackr({ wrap: inherited })
        expect(forEachOwnKey({ a: 1, b: 2 }, () => {})).toBe(2)
    })

    it('headers match msgpackr at every size boundary', () => {
        expect([...mapHeader(0)]).toEqual([0xde, 0, 0])
        expect([...mapHeader(15)]).toEqual([0xde, 0, 15])
        expect([...mapHeader(0xffff)]).toEqual([0xde, 0xff, 0xff])
        expect(() => mapHeader(0x10000)).toThrow(RangeError)
        expect([...arrayHeader(0)]).toEqual([0x90])
        expect([...arrayHeader(15)]).toEqual([0x9f])
        expect([...arrayHeader(16)]).toEqual([0xdc, 0, 16])
        expect([...arrayHeader(0xffff)]).toEqual([0xdc, 0xff, 0xff])
        expect([...arrayHeader(0x10000)]).toEqual([0xdd, 0, 1, 0, 0])
        for (const n of [0, 1, 15, 16, 17, 255, 256, 65535]) {
            const obj: Record<string, number> = {}
            for (let i = 0; i < n; i++) obj[`k${i}`] = i
            expect(oracleEncode(obj).subarray(0, 3).equals(mapHeader(n))).toBe(true)
        }
        for (const n of [0, 1, 15, 16, 17, 65535, 65536]) {
            const arr = new Array(n).fill(0)
            const header = arrayHeader(n)
            expect(oracleEncode(arr).subarray(0, header.length).equals(header)).toBe(true)
        }
    })

    it('composes byte-identical encodings over a seeded random corpus', () => {
        const rand = mulberry32(0xb2b2)
        let containers = 0
        let bytes = 0
        const count = (v: unknown) => {
            if (isComposableObject(v)) { containers++; forEachOwnKey(v, (_k: string, c: unknown) => count(c)) }
            else if (isComposableArray(v)) { containers++; for (const c of v as unknown[]) count(c) }
        }
        for (let i = 0; i < 400; i++) {
            const value = randomValue(rand, 5)
            expectComposedEqualsPackr(value)
            expectComposedEqualsPackr(value, 1)
            count(value)
            bytes += oracleEncode(value).length
        }
        // The corpus really exercises nesting (about 21k containers, 2.4MB).
        expect(containers).toBeGreaterThan(10000)
        expect(bytes).toBeGreaterThan(1_000_000)
    })

    it('composes byte-identical encodings of real-shaped roots at every expansion depth', () => {
        const root = realShapedRoot()
        for (const depth of [0, 1, 2, 3, Infinity]) expectComposedEqualsPackr(root, depth)
        // A frozen root, as dbCache holds it in test mode.
        expectComposedEqualsPackr(Object.freeze({ ...root, characters: Object.freeze((root.characters as object[]).slice()) }), 2)
    })

    it('handles the large container boundaries: array32, map16 max, str32', () => {
        expectComposedEqualsPackr(Array.from({ length: 65536 }, (_, i) => i & 0xff))
        const wide: Record<string, number> = {}
        for (let i = 0; i < 0xffff; i++) wide[`k${i}`] = i & 1
        expectComposedEqualsPackr({ wide })
        expectComposedEqualsPackr(['a'.repeat(65535), 'a'.repeat(65536), '가'.repeat(21845), '가'.repeat(21846), '�'.repeat(30000)])
        // One key more: msgpackr refuses the object, and so does the composer.
        wide.extra = 1
        expect(() => oracle.encode(wide)).toThrow()
        expect(() => composeEncode(wide)).toThrow(RangeError)
    })

    it('runCanary passes on the built-in sample and on a real-shaped root', () => {
        const result = runCanary()
        expect(result).toEqual({ ok: true, bytes: oracleEncode(buildCanarySample()).length })
        expect(runCanary(realShapedRoot(), { maxDepth: 2 }).ok).toBe(true)
    })

    it('runCanary reports a diverging encoder and never throws', () => {
        // variableMapSize writes fixmaps: the leaves agree, the object headers do not.
        const variable = new CjsPackr({ useRecords: false, variableMapSize: true })
        const diverging = runCanary(buildCanarySample(), { encode: (v: unknown) => variable.encode(v) })
        expect(diverging.ok).toBe(false)
        expect(diverging.reason).toMatch(/differ/)

        const tooWide: Record<string, number> = {}
        for (let i = 0; i <= 0xffff; i++) tooWide[`k${i}`] = 0
        const thrown = runCanary(tooWide)
        expect(thrown.ok).toBe(false)
        expect(thrown.reason).toMatch(/threw/)
    })
})
