import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import v8 from 'node:v8'
import vm from 'node:vm'
import * as fflate from 'fflate'
// The ESM build of msgpackr is a separate module instance with its own
// module-level encode scratch, so the oracle below cannot be affected by the
// scratch releases in utils.cjs (which uses the CommonJS build).
import { Packr as OraclePackr } from 'msgpackr'

const requireCjs = createRequire(import.meta.url)
const utils = requireCjs('./utils.cjs')
const { Packr: CjsPackr, Unpackr: CjsUnpackr } = requireCjs('msgpackr')

v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc') as () => void

const MB = 1024 * 1024
const RELEASE_AFTER_BYTES = 16 * MB

// ---- oracle: verbatim copy of encodeRisuSaveLegacy at 9fda95786, before the
// msgpackr scratch release was added ----
const magicHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const magicCompressedHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8])
const packr = new OraclePackr({
    useRecords: false
})
function encodeRisuSaveLegacyOracle(data: any, compression = 'noCompression') {
    let encoded = packr.encode(data);
    if (compression === 'compression') {
        encoded = fflate.compressSync(encoded);
        const result = new Uint8Array(encoded.length + magicCompressedHeader.length);
        result.set(magicCompressedHeader, 0);
        result.set(encoded, magicCompressedHeader.length);
        return result;
    } else {
        const result = new Uint8Array(encoded.length + magicHeader.length);
        result.set(magicHeader, 0);
        result.set(encoded, magicHeader.length);
        return result;
    }
}

// ---- corpus ----
function mulberry32(seed: number) {
    return () => {
        seed |= 0
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function sentencePool(random: () => number, count: number) {
    const pool: string[] = []
    for (let i = 0; i < count; i++) {
        let s = ''
        const length = 20 + Math.floor(random() * 400)
        for (let j = 0; j < length; j++) {
            const r = random()
            if (r < 0.55) s += String.fromCharCode(0xac00 + Math.floor(random() * 11172)) // Hangul
            else if (r < 0.9) s += String.fromCharCode(0x61 + Math.floor(random() * 26))
            else if (r < 0.97) s += ' '
            else if (r < 0.99) s += '\n'
            else s += '\u{1F600}'
        }
        pool.push(s)
    }
    return pool
}

// Database-shaped value, roughly `targetBytes` when encoded.
function syntheticDatabase(targetBytes: number, seed = 1) {
    const random = mulberry32(seed)
    const pool = sentencePool(random, 256)
    const pick = () => pool[Math.floor(random() * pool.length)]
    const characters: any[] = []
    let approx = 0
    for (let c = 0; approx < targetBytes; c++) {
        const chats: any[] = []
        for (let h = 0; h < 3; h++) {
            const message: any[] = []
            for (let m = 0; m < 40; m++) {
                const data = pick() + pick() + pick()
                approx += data.length * 2.2 + 60
                message.push({
                    role: m % 2 ? 'char' : 'user',
                    data,
                    chatId: `msg-${c}-${h}-${m}`,
                    time: 1_700_000_000_000 + m * 1000,
                    saying: m % 5 === 0 ? undefined : `c${c}`,
                    generationInfo: m % 7 === 0 ? { model: 'x', inputTokens: m * 13, outputTokens: m * 7, maxContext: 128000 } : undefined,
                })
            }
            chats.push({ id: `chat-${c}-${h}`, name: pick().slice(0, 20), message, note: '', localLore: [], fmIndex: -1, folderId: h ? null : undefined })
        }
        characters.push({
            chaId: `cha-${c}`,
            name: pick().slice(0, 12),
            desc: pick(),
            firstMessage: pick(),
            chats,
            chatPage: 0,
            additionalAssets: [['a', `assets/${c}.png`, 'png'], ['b', `assets/${c}.webp`]],
            utilityBot: false,
            lowLevelAccess: undefined,
        })
    }
    return { formatversion: 3, characters, botPresets: [{ id: 'p', name: 'preset', temperature: 80 }], modules: [] }
}

const LARGE_DB = syntheticDatabase(20 * MB)

function smallCorpus(): Array<[string, any]> {
    const repeatBytes = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit)))
    const typed = {
        u8: new Uint8Array([0, 1, 2, 255]),
        buffer: Buffer.from('buffer bytes'),
        i8: new Int8Array([-128, 0, 127]),
        u16: new Uint16Array([0, 65535]),
        i32: new Int32Array([-2147483648, 2147483647]),
        f32: new Float32Array([1.5, -0.25]),
        f64: new Float64Array([Math.PI, -Infinity]),
        dataView: new DataView(new Uint8Array([1, 2, 3, 4]).buffer),
        arrayBuffer: new Uint8Array([9, 8, 7]).buffer,
    }
    const deep: any = { leaf: 'bottom' }
    let node = deep
    for (let i = 0; i < 60; i++) node = { level: i, child: node, list: [node.leaf ?? null] }
    const wide: Record<string, number> = {}
    for (let i = 0; i < 1500; i++) wide[`key${i}`] = i
    return [
        ['null', null],
        ['undefined at the top', undefined],
        ['booleans', [true, false]],
        ['integers', [0, -0, 1, -1, 127, 128, -32, -33, 255, 256, 65535, 65536, 2 ** 31 - 1, 2 ** 31, 2 ** 32, 2 ** 53 - 1, -(2 ** 53 - 1), -(2 ** 31)]],
        ['floats', [0.5, -1.5, 1e300, Number.MIN_VALUE, Number.EPSILON, NaN, Infinity, -Infinity]],
        ['bigints', [123n, -(2n ** 63n), 2n ** 64n - 1n]],
        ['strings', ['', 'a', '한국어 텍스트', '\u{1F600} emoji', '\ud800 lone surrogate', 'nul\u0000inside']],
        ['string length boundaries', [31, 32, 255, 256, 65535, 65536].flatMap((n) => ['x'.repeat(n), '가'.repeat(n)])],
        ['large string', repeatBytes('대화 ', 3 * MB)],
        ['undefined values', { a: undefined, b: [undefined, 1, undefined], c: { d: undefined }, e: null }],
        ['nested objects', deep],
        ['wide object', wide],
        ['odd keys', JSON.parse('{"__proto__":{"x":1},"constructor":"c","":"empty","한글":"키","1":"numeric"}')],
        ['typed arrays', typed],
        ['date, map, set', { date: new Date(1_700_000_000_123), map: new Map<any, any>([['k', 1], [2, 'v']]), set: new Set([1, 'two']) }],
        ['empty containers', { a: [], o: {}, s: '' }],
        ['medium database', syntheticDatabase(2 * MB, 7)],
    ]
}

const SMALL_CORPUS = smallCorpus()
const corpusValue = (label: string) => {
    const entry = SMALL_CORPUS.find(([name]) => name === label)
    if (!entry) throw new Error(label)
    return entry[1]
}
const MEDIUM_DB = corpusValue('medium database')

function expectSameBytes(actual: Uint8Array, expected: Uint8Array) {
    expect(actual.length).toBe(expected.length)
    expect(Buffer.compare(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength),
        Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength))).toBe(0)
}

// Byte size of the ArrayBuffer msgpackr is currently encoding into (the
// module-level scratch shared by every CommonJS Packr, utils.cjs's included).
function encodeScratchBytes() {
    return new CjsPackr({ useRecords: false }).encode(null).buffer.byteLength
}

const nextTask = () => new Promise((resolve) => setImmediate(resolve))

// V8 frees ArrayBuffer backing stores on a concurrent sweeper, so the
// arrayBuffers counter can lag one collection behind; the second gc()
// finishes that sweep first.
async function collectFully() {
    await nextTask()
    gc()
    await nextTask()
    gc()
}

describe('encodeRisuSaveLegacy output bytes', () => {
    it('uses a msgpackr instance separate from the oracle', () => {
        expect(CjsPackr).not.toBe(OraclePackr)
    })

    it('matches the previous implementation byte for byte on the corpus', () => {
        const largeBinary = new Uint8Array(17 * MB).map((_, i) => (i * 31) & 0xff)
        const corpus: Array<[string, any]> = [...SMALL_CORPUS,
            ['database over 16MB', LARGE_DB],
            ['string over 16MB', '큰 문자열 '.repeat(2 * MB)],
            ['binary over 16MB', { image: largeBinary, meta: { type: 'png' } }]]
        for (const [label, value] of corpus) {
            const expected = encodeRisuSaveLegacyOracle(value)
            const actual = utils.encodeRisuSaveLegacy(value)
            expect(actual, label).toBeInstanceOf(Uint8Array)
            expect(Buffer.isBuffer(actual), label).toBe(false)
            expectSameBytes(actual, expected)
        }
        expect(encodeRisuSaveLegacyOracle(LARGE_DB).length).toBeGreaterThan(RELEASE_AFTER_BYTES + 11)
    })

    it('matches the previous implementation with compression', () => {
        // fflate's gzip header carries Date.now() in seconds; hold the clock.
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
        try {
            const corpus = [...SMALL_CORPUS.slice(0, 12), ['database over 16MB', LARGE_DB] as [string, any]]
            for (const [label, value] of corpus) {
                const expected = encodeRisuSaveLegacyOracle(value, 'compression')
                const actual = utils.encodeRisuSaveLegacy(value, 'compression')
                expect(actual.length, label).toBe(expected.length)
                expectSameBytes(actual, expected)
            }
            const compressed = utils.encodeRisuSaveLegacyBuffer(MEDIUM_DB, 'compression')
            expectSameBytes(compressed, encodeRisuSaveLegacyOracle(MEDIUM_DB, 'compression'))
        } finally {
            clock.mockRestore()
        }
    })

    it('stays identical when large and small encodes interleave', () => {
        const sequence = [corpusValue('undefined values'), LARGE_DB, MEDIUM_DB, LARGE_DB,
            corpusValue('integers'), corpusValue('large string'), LARGE_DB]
        const first = utils.encodeRisuSaveLegacy(LARGE_DB)
        for (const value of sequence) {
            expectSameBytes(utils.encodeRisuSaveLegacy(value), encodeRisuSaveLegacyOracle(value))
        }
        expectSameBytes(utils.encodeRisuSaveLegacy(LARGE_DB), first)
    })

    it('encodeRisuSaveLegacyBuffer returns the same bytes in a Buffer that owns its memory', () => {
        for (const [, value] of [...SMALL_CORPUS, ['large', LARGE_DB] as [string, any]]) {
            const buffer = utils.encodeRisuSaveLegacyBuffer(value)
            expect(Buffer.isBuffer(buffer)).toBe(true)
            expect(buffer.byteOffset).toBe(0)
            expect(buffer.buffer.byteLength).toBe(buffer.length)
            expectSameBytes(buffer, encodeRisuSaveLegacyOracle(value))
        }
    })

    it('encodeMsgpackOwned equals packr.encode in an exact-size buffer outside the Buffer pool', () => {
        for (const [, value] of [...SMALL_CORPUS, ['large', LARGE_DB] as [string, any]]) {
            const owned = utils.encodeMsgpackOwned(value)
            expect(Buffer.isBuffer(owned)).toBe(true)
            expect(owned.byteOffset).toBe(0)
            expect(owned.buffer.byteLength).toBe(owned.length)
            expectSameBytes(owned, encodeRisuSaveLegacyOracle(value).subarray(magicHeader.length))
        }
        // Two tiny values never share memory (a pooled Buffer would).
        const a = utils.encodeMsgpackOwned({ a: 1 })
        const b = utils.encodeMsgpackOwned({ b: 2 })
        expect(a.buffer).not.toBe(b.buffer)
    })

    it('throws for values the previous implementation rejected', () => {
        expect(() => encodeRisuSaveLegacyOracle({ tooBig: 2n ** 64n })).toThrow()
        expect(() => utils.encodeRisuSaveLegacy({ tooBig: 2n ** 64n })).toThrow()
        expect(() => utils.encodeMsgpackOwned({ tooBig: 2n ** 64n })).toThrow()
    })
})

describe('msgpackr module state after large calls', () => {
    it('encodeRisuSaveLegacy hands back the encode scratch after a large encode, and keeps it after small ones', () => {
        utils.encodeRisuSaveLegacy(LARGE_DB)
        expect(encodeScratchBytes()).toBe(8192)

        utils.encodeRisuSaveLegacy(MEDIUM_DB)
        const kept = encodeScratchBytes()
        expect(kept).toBeGreaterThan(MB)
        utils.encodeRisuSaveLegacy({ small: true })
        expect(encodeScratchBytes()).toBe(kept)

        utils.encodeRisuSaveLegacy(LARGE_DB, 'compression')
        expect(encodeScratchBytes()).toBe(8192)
    })

    it('encodeRisuSaveLegacyBuffer and encodeMsgpackOwned release after large encodes too', () => {
        new CjsPackr({ useRecords: false }).encode(MEDIUM_DB)
        expect(encodeScratchBytes()).toBeGreaterThan(MB)
        utils.encodeRisuSaveLegacyBuffer(LARGE_DB)
        expect(encodeScratchBytes()).toBe(8192)

        new CjsPackr({ useRecords: false }).encode(MEDIUM_DB)
        utils.encodeMsgpackOwned(LARGE_DB)
        expect(encodeScratchBytes()).toBe(8192)
    })

    it('a failed encode releases the scratch and the next encode is unchanged', () => {
        new CjsPackr({ useRecords: false }).encode(MEDIUM_DB)
        expect(() => utils.encodeRisuSaveLegacy({ big: 'x'.repeat(17 * MB), tooBig: 2n ** 64n })).toThrow()
        expect(encodeScratchBytes()).toBe(8192)
        expectSameBytes(utils.encodeRisuSaveLegacy(LARGE_DB), encodeRisuSaveLegacyOracle(LARGE_DB))
    })

    it('releaseEncodeScratch frees a scratch grown by another Packr instance', async () => {
        const grow = () => {
            const view = new CjsPackr({ useRecords: false }).encode({ big: 'y'.repeat(20 * MB) })
            expect(view.length).toBeGreaterThan(RELEASE_AFTER_BYTES)
            return new WeakRef(view.buffer)
        }
        const scratch = grow()
        await collectFully()
        // Control: msgpackr alone keeps the scratch after the view is gone.
        expect(scratch.deref() !== undefined).toBe(true)

        utils.releaseEncodeScratch()
        await collectFully()
        expect(scratch.deref() === undefined).toBe(true)
        expect(encodeScratchBytes()).toBe(8192)
    })

    it('decodeRisuSave does not keep a large source alive', async () => {
        const encoded = encodeRisuSaveLegacyOracle({ text: 'z'.repeat(20 * MB), n: 1 })
        const makeSource = () => {
            // A Buffer, like kvGet returns: data.slice(header) is then a view.
            const source = Buffer.allocUnsafeSlow(encoded.length)
            source.set(encoded)
            return source
        }
        const decodeWith = async (decodeFn: (source: Buffer) => unknown) => {
            const source = makeSource()
            const ref = new WeakRef(source.buffer)
            const decoded: any = await decodeFn(source)
            expect(decoded.text.length).toBe(20 * MB)
            return ref
        }

        // Control: a plain msgpackr decode keeps its source alive.
        const plain = await decodeWith((source) => new CjsUnpackr({ useRecords: false }).decode(source.subarray(11)))
        await collectFully()
        expect(plain.deref() !== undefined).toBe(true)

        const viaUtils = await decodeWith((source) => utils.decodeRisuSave(source))
        await collectFully()
        expect(viaUtils.deref() === undefined).toBe(true)
        expect(plain.deref() === undefined).toBe(true)
    })

    it('arrayBuffers return to the baseline after a 64MB encode and decode', async () => {
        const run = async () => {
            const value = { text: 'w'.repeat(64 * MB), list: [1, 2, 3] }
            const bytes = utils.encodeRisuSaveLegacyBuffer(value)
            expect(bytes.length).toBeGreaterThan(64 * MB)
            const decoded: any = await utils.decodeRisuSave(bytes)
            expect(decoded.text.length).toBe(64 * MB)
        }
        utils.releaseEncodeScratch()
        await collectFully()
        const before = process.memoryUsage().arrayBuffers
        await run()
        await collectFully()
        const after = process.memoryUsage().arrayBuffers
        expect(after - before).toBeLessThan(8 * MB)
    })
})

describe('msgpackr version pin', () => {
    it('package.json pins msgpackr to the exact installed version', () => {
        const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'))
        const spec = pkg.dependencies.msgpackr
        // utils.cjs releases msgpackr's module-level buffers through internals
        // that are not public API; see the comment at the top of utils.cjs.
        expect(spec).toMatch(/^\d+\.\d+\.\d+$/)
        const installedMain = requireCjs.resolve('msgpackr')
        const installed = JSON.parse(readFileSync(join(dirname(installedMain), '..', 'package.json'), 'utf8'))
        expect(installed.version).toBe(spec)
    })
})
