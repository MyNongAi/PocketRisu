import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, unknown>())

vi.mock('src/ts/storage/persistentKv', () => ({
    makeHashedStorageKey: vi.fn(async (prefix: string, rawKey: string) => `${prefix}${rawKey}.json`),
    readPersistentJson: vi.fn(async (key: string) => store.get(key) ?? null),
    writePersistentJson: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value)
    }),
}))
vi.mock('src/ts/globalApi.svelte', () => ({ globalFetch: vi.fn() }))
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => ({}) }))
vi.mock('src/ts/util', () => ({ appendLastPath: vi.fn() }))
vi.mock('src/ts/network/localNetwork', () => ({ isLocalNetworkUrl: () => false }))
vi.mock('../transformers', () => ({ runEmbedding: vi.fn() }))
vi.mock('./contextualEmbedding', () => ({
    isContextModel: () => false,
    getContextProvider: vi.fn(),
}))

import { readPersistentJson } from 'src/ts/storage/persistentKv'
import {
    HYPA_VECTOR_CACHE_LIMIT,
    getPersistedHypaVector,
    hypaVectorCache,
    setPersistedHypaVector,
} from './hypamemory'

async function fill(count: number) {
    for (let i = 0; i < count; i++) {
        await setPersistedHypaVector(`v${i}`, { content: `v${i}`, embedding: [i, 1] })
    }
}

beforeEach(() => {
    hypaVectorCache.clear()
    store.clear()
    vi.clearAllMocks()
})

describe('hypaVectorCache', () => {
    it('holds 1024 vectors by default', () => {
        expect(HYPA_VECTOR_CACHE_LIMIT).toBe(1024)
        expect(hypaVectorCache.maxEntries).toBe(HYPA_VECTOR_CACHE_LIMIT)
    })

    it('drops the least recently used vectors past the cap but keeps them persisted', async () => {
        await fill(HYPA_VECTOR_CACHE_LIMIT + 10)
        expect(hypaVectorCache.size).toBe(HYPA_VECTOR_CACHE_LIMIT)
        expect(hypaVectorCache.has('v0')).toBe(false)
        expect(hypaVectorCache.has('v9')).toBe(false)
        expect(hypaVectorCache.has('v10')).toBe(true)
        expect(hypaVectorCache.has(`v${HYPA_VECTOR_CACHE_LIMIT + 9}`)).toBe(true)
        expect(store.size).toBe(HYPA_VECTOR_CACHE_LIMIT + 10)
    })

    it('reads an evicted vector back from persistent storage without evicting others when full', async () => {
        await fill(HYPA_VECTOR_CACHE_LIMIT + 1)
        expect(hypaVectorCache.has('v0')).toBe(false)

        expect(await getPersistedHypaVector('v0')).toEqual({ content: 'v0', embedding: [0, 1] })
        expect(readPersistentJson).toHaveBeenCalledTimes(1)
        // The cache is full: the read is answered but not cached, so a scan
        // longer than the cap keeps hitting the vectors already in memory.
        expect(hypaVectorCache.has('v0')).toBe(false)
        expect(hypaVectorCache.has('v1')).toBe(true)
        expect(hypaVectorCache.size).toBe(HYPA_VECTOR_CACHE_LIMIT)
    })

    it('caches a vector read back from storage while there is room', async () => {
        await fill(3)
        hypaVectorCache.delete('v0')
        expect(await getPersistedHypaVector('v0')).toEqual({ content: 'v0', embedding: [0, 1] })
        expect(hypaVectorCache.has('v0')).toBe(true)
    })

    it('a scan longer than the cap still hits the vectors kept in memory', async () => {
        await fill(HYPA_VECTOR_CACHE_LIMIT + 20)
        vi.mocked(readPersistentJson).mockClear()
        for (let i = 0; i < HYPA_VECTOR_CACHE_LIMIT + 20; i++) await getPersistedHypaVector(`v${i}`)
        // Only the 20 vectors that never fit are read from storage.
        expect(readPersistentJson).toHaveBeenCalledTimes(20)
    })

    it('a cache hit skips persistent storage and keeps the vector from being evicted', async () => {
        await fill(HYPA_VECTOR_CACHE_LIMIT)

        expect(await getPersistedHypaVector('v0')).toEqual({ content: 'v0', embedding: [0, 1] })
        expect(readPersistentJson).not.toHaveBeenCalled()

        await setPersistedHypaVector('extra', { content: 'extra', embedding: [0, 0] })
        expect(hypaVectorCache.has('v0')).toBe(true)
        expect(hypaVectorCache.has('v1')).toBe(false)
    })

    it('a miss that is not persisted caches nothing', async () => {
        expect(await getPersistedHypaVector('nowhere')).toBeUndefined()
        expect(hypaVectorCache.size).toBe(0)
    })
})
