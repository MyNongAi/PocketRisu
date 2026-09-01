import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoundedObjectUrlCache, createDeduplicatedImageLoader } from './boundedObjectUrlCache'

afterEach(() => {
    vi.restoreAllMocks()
})

describe('BoundedObjectUrlCache', () => {
    it('promotes reads and evicts the least recently used entry', () => {
        const cache = new BoundedObjectUrlCache(2, 2)
        cache.set('a', 'https://example/a')
        cache.set('b', 'https://example/b')
        expect(cache.get('a')).toBe('https://example/a')
        cache.set('c', 'https://example/c')
        expect(cache.get('b')).toBeUndefined()
        expect(cache.get('a')).toBe('https://example/a')
        expect(cache.get('c')).toBe('https://example/c')
    })

    it('bounds full-resolution entries independently and revokes blob URLs', () => {
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
        const cache = new BoundedObjectUrlCache(10, 1)
        cache.set('thumb', 'blob:thumb')
        cache.set('full-a', 'blob:full-a', true)
        cache.set('full-b', 'blob:full-b', true)
        expect(cache.get('full-a')).toBeUndefined()
        expect(cache.get('full-b')).toBe('blob:full-b')
        expect(revoke).toHaveBeenCalledWith('blob:full-a')
        expect(cache.get('thumb')).toBe('blob:thumb')
    })

    it('deduplicates concurrent image loads', async () => {
        const cache = new BoundedObjectUrlCache(4, 2)
        const load = createDeduplicatedImageLoader(cache)
        const loader = vi.fn(async () => 'blob:shared')
        const [first, second] = await Promise.all([
            load('same', loader, true),
            load('same', loader, true),
        ])
        expect(first).toBe('blob:shared')
        expect(second).toBe('blob:shared')
        expect(loader).toHaveBeenCalledTimes(1)
    })

    it('clears a failed request so the same key can retry', async () => {
        const cache = new BoundedObjectUrlCache(4, 2)
        const load = createDeduplicatedImageLoader(cache)
        const loader = vi.fn()
            .mockRejectedValueOnce(new Error('temporary'))
            .mockResolvedValueOnce('blob:recovered')

        await expect(load('same', loader, true)).rejects.toThrow('temporary')
        await expect(load('same', loader, true)).resolves.toBe('blob:recovered')
        expect(loader).toHaveBeenCalledTimes(2)
    })
})
