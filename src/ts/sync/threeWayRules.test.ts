import { describe, expect, it } from 'vitest'

import { CONFLICT, INDEX_ROOT_KEYS, clampPage, jsonDeepEqual, maxNumber, mergeCounters, openChatId, resolveIndexKey } from './threeWayRules'

describe('jsonDeepEqual', () => {
    it('ignores key order and compares arrays in order', () => {
        expect(jsonDeepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true)
        expect(jsonDeepEqual([1, 2], [2, 1])).toBe(false)
        expect(jsonDeepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
        expect(jsonDeepEqual({ a: null }, { a: undefined })).toBe(false)
        expect(jsonDeepEqual([], {})).toBe(false)
        expect(jsonDeepEqual('1', 1)).toBe(false)
        expect(jsonDeepEqual(null, {})).toBe(false)
    })

    it('stops at identity without walking the shared subtree', () => {
        let reads = 0
        const shared = new Proxy({ x: 1 }, { ownKeys(target) { reads++; return Reflect.ownKeys(target) } })
        expect(jsonDeepEqual({ a: shared, b: 2 }, { b: 2, a: shared })).toBe(true)
        expect(jsonDeepEqual(shared, shared)).toBe(true)
        expect(reads).toBe(0)
    })

    it('does not count inherited keys as present', () => {
        expect(jsonDeepEqual({ toString: 1 }, { other: 1 })).toBe(false)
    })
})

describe('mergeCounters', () => {
    it('keeps both deltas (A +2, B +3 from 10 gives 15)', () => {
        expect(mergeCounters({ messages: 10, imports: 4 }, { messages: 12, imports: 4 }, { messages: 13, imports: 4 }))
            .toEqual({ messages: 15, imports: 4 })
    })

    it('counts an absent key as 0', () => {
        expect(mergeCounters({}, { messages: 2 }, { messages: 3 })).toEqual({ messages: 5 })
        expect(mergeCounters(undefined, { messages: 2 }, { imports: 1 })).toEqual({ messages: 2, imports: 1 })
        expect(mergeCounters({ messages: 1 }, { messages: 3 }, { messages: 1, imports: 7 })).toEqual({ messages: 3, imports: 7 })
    })

    it('falls back to three-way for non-numbers', () => {
        // The side that changed it wins.
        expect(mergeCounters({ messages: 1, tag: 'a' }, { messages: 2, tag: 'b' }, { messages: 1, tag: 'a' })).toEqual({ messages: 2, tag: 'b' })
        expect(mergeCounters({ tag: 'a' }, { tag: 'a' }, { tag: 'c' })).toEqual({ tag: 'c' })
        expect(mergeCounters({ tag: 'a' }, { tag: 'x' }, { tag: 'x' })).toEqual({ tag: 'x' })
        // Two different changes do not combine.
        expect(mergeCounters({ tag: 'a' }, { tag: 'b' }, { tag: 'c' })).toBe(CONFLICT)
        expect(mergeCounters({ messages: 1 }, { messages: 'many' }, { messages: 2 })).toBe(CONFLICT)
    })

    it('refuses what is not a bag of counters', () => {
        expect(mergeCounters({ messages: 1 }, 5, { messages: 2 })).toBe(CONFLICT)
        expect(mergeCounters({ messages: 1 }, { messages: 2 }, null)).toBe(CONFLICT)
        expect(mergeCounters([1], { messages: 2 }, { messages: 2 })).toBe(CONFLICT)
        expect(mergeCounters({ messages: 1 }, { messages: 2 }, { messages: Infinity })).toBe(CONFLICT)
        expect(mergeCounters({}, JSON.parse('{"__proto__": 1}'), {})).toBe(CONFLICT)
    })
})

describe('maxNumber', () => {
    it('takes the larger number', () => {
        expect(maxNumber(5, 9)).toBe(9)
        expect(maxNumber(9, 5)).toBe(9)
        expect(maxNumber(-1, -1)).toBe(-1)
    })

    it('refuses anything else', () => {
        expect(maxNumber(undefined, 5)).toBe(CONFLICT)
        expect(maxNumber('5', 4)).toBe(CONFLICT)
        expect(maxNumber(NaN, 4)).toBe(CONFLICT)
    })
})

describe('INDEX_ROOT_KEYS', () => {
    it('pairs each index key with its list', () => {
        expect(INDEX_ROOT_KEYS.map(({ key, list }) => `${key}>${list}`)).toEqual([
            'botPresetsId>botPresets', 'selectedPersona>personas', 'translatorPresetId>translatorPresets', 'loreBookPage>loreBook',
        ])
    })
})

describe('resolveIndexKey', () => {
    const list = (...ids: string[]) => ids.map((id) => ({ id }))
    const b = list('p1', 'p2')

    it('local choice, remote list insert: re-pointed into the remote list', () => {
        expect(resolveIndexKey({ bList: b, bIdx: 0, lList: b, lIdx: 1, rList: list('p0', 'p1', 'p2'), rIdx: 0, listFromRemote: true })).toBe(2)
        // The remote re-pointed its own index with the insert: no choice of its own.
        expect(resolveIndexKey({ bList: b, bIdx: 0, lList: b, lIdx: 1, rList: list('p0', 'p1', 'p2'), rIdx: 1, listFromRemote: true })).toBe(2)
    })

    it('remote choice, local list change: re-pointed into the local list', () => {
        expect(resolveIndexKey({ bList: b, bIdx: 0, lList: list('p0', 'p1', 'p2'), lIdx: 1, rList: b, rIdx: 1, listFromRemote: false })).toBe(2)
    })

    it('a chosen element missing from the merged list is a conflict', () => {
        // Local picked p2, the remote deleted it.
        expect(resolveIndexKey({ bList: b, bIdx: 0, lList: b, lIdx: 1, rList: list('p1'), rIdx: 0, listFromRemote: true })).toBe(CONFLICT)
        // Remote picked p2, local deleted it.
        expect(resolveIndexKey({ bList: b, bIdx: 0, lList: list('p1'), lIdx: 0, rList: b, rIdx: 1, listFromRemote: false })).toBe(CONFLICT)
    })

    it('both sides choosing: the same element is fine, different ones conflict', () => {
        const three = list('p1', 'p2', 'p3')
        expect(resolveIndexKey({ bList: three, bIdx: 0, lList: three, lIdx: 1, rList: three, rIdx: 1, listFromRemote: false })).toBe(1)
        expect(resolveIndexKey({ bList: three, bIdx: 0, lList: three, lIdx: 1, rList: three, rIdx: 2, listFromRemote: false })).toBe(CONFLICT)
    })

    it('neither choosing keeps B\'s element where the list moved it', () => {
        expect(resolveIndexKey({ bList: b, bIdx: 1, lList: b, lIdx: 1, rList: list('p2', 'p1'), rIdx: 0, listFromRemote: true })).toBe(0)
    })

    it('missing or duplicate ids, and out-of-range indexes, are conflicts', () => {
        const noIds = [{ name: 'a' }, { name: 'b' }]
        expect(resolveIndexKey({ bList: noIds, bIdx: 0, lList: noIds, lIdx: 1, rList: noIds, rIdx: 0, listFromRemote: true })).toBe(CONFLICT)
        const dup = list('p1', 'p1')
        expect(resolveIndexKey({ bList: b, bIdx: 0, lList: b, lIdx: 1, rList: dup, rIdx: 0, listFromRemote: true })).toBe(CONFLICT)
        expect(resolveIndexKey({ bList: b, bIdx: 0, lList: list('p1', ''), lIdx: 1, rList: b, rIdx: 0, listFromRemote: true })).toBe(CONFLICT)
        expect(resolveIndexKey({ bList: b, bIdx: 0, lList: b, lIdx: 7, rList: list('p0', 'p1', 'p2'), rIdx: 0, listFromRemote: true })).toBe(CONFLICT)
        expect(resolveIndexKey({ bList: b, bIdx: 0, lList: b, lIdx: 1, rList: undefined, rIdx: 0, listFromRemote: true })).toBe(CONFLICT)
    })
})

describe('openChatId and clampPage', () => {
    it('reads the open chat id', () => {
        expect(openChatId({ chatPage: 1, chats: [{ id: 'a' }, { id: 'b' }] })).toBe('b')
        expect(openChatId({ chatPage: 5, chats: [{ id: 'a' }] })).toBeUndefined()
        expect(openChatId({ chatPage: 0 })).toBeUndefined()
        expect(openChatId(undefined)).toBeUndefined()
    })

    it('clamps into the chat list', () => {
        expect(clampPage(3, 2)).toBe(1)
        expect(clampPage(-1, 2)).toBe(0)
        expect(clampPage(1, 0)).toBe(0)
        expect(clampPage(1, 3)).toBe(1)
        expect(clampPage(NaN, 3)).toBe(0)
        expect(clampPage(undefined, 3)).toBe(0)
    })
})
