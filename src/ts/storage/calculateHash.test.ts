import { describe, expect, test, vi } from 'vitest'
import utilsPkg from '../../../server/node/utils.cjs'

vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))
vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({ chatToStub: (c: any) => c }))

const { calculateHash } = await import('./risuSave')
const server = utilsPkg as { calculateHash: (value: any) => number }

// The hash as it was written before calculateHash read characters through
// String.prototype.charCodeAt.call; the server still uses this form.
function reference(node: any): number {
    if (node === null || node === undefined) return 37
    switch (typeof node) {
        case 'object':
            if (Array.isArray(node)) {
                let h = 19
                for (const item of node) h = (Math.imul(h, 31) + reference(item)) >>> 0
                return h
            } else {
                let h = 17
                for (const key in node) h += Math.imul(reference(key), 31) + reference(node[key])
                return h >>> 0
            }
        case 'string': {
            let h = 2166136261
            for (let i = 0; i < node.length; i++) h = Math.imul(h ^ node.charCodeAt(i), 16777619)
            return Math.imul(23, 31) + (h >>> 0)
        }
        case 'number': {
            let n
            if (Number.isInteger(node) && node >= -2147483648 && node <= 2147483647) n = node >>> 0
            else {
                const str = node.toString()
                n = 2166136261
                for (let i = 0; i < str.length; i++) n = Math.imul(n ^ str.charCodeAt(i), 16777619)
                n = n >>> 0
            }
            return Math.imul(29, 31) + n
        }
        case 'boolean':
            return Math.imul(31, 31) + (node ? 1 : 0)
        default:
            return 0
    }
}

/** The same text in the string representations V8 hands out. */
function representations() {
    const ascii = 'abcdefghijklmnopqrstuvwxyz0123456789 '.repeat(30)
    const korean = '한국어 문장과 이모지 🌙 '.repeat(30)
    const asKey = (s: string) => { const o: Record<string, number> = {}; o[s] = 1; return s }
    return [
        '', 'a', 'é', '😀', 'lone \ud800 high', 'lone \udc00 low',
        ascii, korean,
        ascii.slice(7, 400),                       // sliced one-byte
        korean.slice(3, 200),                      // sliced two-byte
        ascii.slice(0, 300) + korean.slice(0, 50), // cons
        asKey(`thin-${ascii.slice(0, 40)}-${Math.random()}`),
        asKey(`얇은-${Math.random()}`),
        Object.keys({ internalizedKey: 1 })[0],
        Object.keys({ 내부화된키: 1 })[0],
        JSON.parse(JSON.stringify(korean)),
    ]
}

describe('calculateHash', () => {
    test('matches the reference and the server for every string representation', () => {
        for (const s of representations()) {
            expect(calculateHash(s)).toBe(reference(s))
            expect(calculateHash(s)).toBe(server.calculateHash(s))
        }
    })

    test('matches the server on nested values mixing them', () => {
        const strings = representations()
        const value = {
            list: strings,
            byKey: Object.fromEntries(strings.map((s, i) => [`k${i}${s.slice(0, 5)}`, s])),
            numbers: [0, -1, 2147483647, 2147483648, 0.1, 1e21, -0.5],
            flags: [true, false, null],
            nested: { deeper: { again: strings.slice(3, 9) } },
        }
        // Hash repeatedly so the string branch has seen every representation.
        for (let i = 0; i < 200; i++) calculateHash(value)
        expect(calculateHash(value)).toBe(reference(value))
        expect(calculateHash(value)).toBe(server.calculateHash(value))
    })
})
