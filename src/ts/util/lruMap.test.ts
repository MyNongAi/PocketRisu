import { describe, expect, it } from 'vitest'
import { LruMap } from './lruMap'

describe('LruMap', () => {
    it('evicts the least recently inserted key once past the cap', () => {
        const cache = new LruMap<string, number>(3)
        cache.set('a', 1).set('b', 2).set('c', 3).set('d', 4)
        expect(cache.size).toBe(3)
        expect(cache.has('a')).toBe(false)
        expect([...cache.keys()]).toEqual(['b', 'c', 'd'])
    })

    it('a read hit makes the key the most recently used', () => {
        const cache = new LruMap<string, number>(3)
        cache.set('a', 1).set('b', 2).set('c', 3)
        expect(cache.get('a')).toBe(1)
        cache.set('d', 4)
        expect(cache.has('a')).toBe(true)
        expect(cache.has('b')).toBe(false)
        expect([...cache.keys()]).toEqual(['c', 'a', 'd'])
    })

    it('has() and iteration do not refresh recency', () => {
        const cache = new LruMap<string, number>(2)
        cache.set('a', 1).set('b', 2)
        expect(cache.has('a')).toBe(true)
        expect([...cache.entries()]).toEqual([['a', 1], ['b', 2]])
        cache.set('c', 3)
        expect(cache.has('a')).toBe(false)
    })

    it('overwriting a key refreshes it without growing the map', () => {
        const cache = new LruMap<string, number>(2)
        cache.set('a', 1).set('b', 2).set('a', 10)
        expect(cache.size).toBe(2)
        cache.set('c', 3)
        expect(cache.get('a')).toBe(10)
        expect(cache.has('b')).toBe(false)
    })

    it('a miss returns undefined and inserts nothing', () => {
        const cache = new LruMap<string, number>(2)
        cache.set('a', 1)
        expect(cache.get('missing')).toBeUndefined()
        expect(cache.size).toBe(1)
        expect([...cache.keys()]).toEqual(['a'])
    })

    it('keeps a stored undefined value distinct from a miss', () => {
        const cache = new LruMap<string, number | undefined>(2)
        cache.set('a', undefined).set('b', 2)
        expect(cache.get('a')).toBeUndefined()
        cache.set('c', 3)
        // The read above moved 'a' ahead of 'b'
        expect(cache.has('a')).toBe(true)
        expect(cache.has('b')).toBe(false)
    })

    it('stays a Map for delete, clear and instanceof', () => {
        const cache = new LruMap<string, number>(2)
        cache.set('a', 1).set('b', 2)
        expect(cache).toBeInstanceOf(Map)
        expect(cache.delete('a')).toBe(true)
        cache.set('c', 3)
        expect([...cache.keys()]).toEqual(['b', 'c'])
        cache.clear()
        expect(cache.size).toBe(0)
    })

    it('rejects a cap that is not a positive integer', () => {
        expect(() => new LruMap(0)).toThrow(RangeError)
        expect(() => new LruMap(-1)).toThrow(RangeError)
        expect(() => new LruMap(1.5)).toThrow(RangeError)
        expect(() => new LruMap(Number.NaN)).toThrow(RangeError)
    })
})
