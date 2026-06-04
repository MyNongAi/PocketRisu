import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable test doubles created before vi.mock factories run.
const { mockDb, state } = vi.hoisted(() => ({
    mockDb: { db: {} as any },
    state: { responders: {} as Record<string, () => unknown> },
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    fetchNative: vi.fn(async (url: string) => {
        const responder = state.responders[url]
        if (!responder) return { ok: false, status: 404, json: async () => ({}) }
        return { ok: true, status: 200, json: async () => responder() }
    }),
}))

vi.mock('src/ts/stores.svelte', () => ({ DBState: mockDb }))

import { fetchRemoteRegistry, getOfficialRegistry, isRefetchGuarded, syncRemoteRegistry } from './remote'
import { getBundledRegistryId, loadBundledRegistry } from './loader'

const BASE = 'https://raw.githubusercontent.com/PocketRisu/pocketrisu-model-registry/main/'

function indexJson(updatedAt: number, schemaVersion = 4) {
    return {
        schemaVersion,
        contentVersion: 1,
        updatedAt,
        baseProviders: [{ id: 'openai', url: 'base-providers/openai.json', version: 1 }],
        profiles: [{ id: 'openai:gpt', url: 'profiles/openai/gpt.json', version: 1 }],
    }
}

function setupHappyResponders(updatedAt = 1000, opts: { schemaVersion?: number; orphanProfile?: boolean } = {}) {
    state.responders = {
        [BASE + 'index.json']: () => indexJson(updatedAt, opts.schemaVersion ?? 4),
        [BASE + 'base-providers/openai.json']: () => (opts.orphanProfile ? { id: 'other' } : { id: 'openai', adapterKind: 'openaiCompatible', version: 1 }),
        [BASE + 'profiles/openai/gpt.json']: () => ({ id: 'openai:gpt', providerBaseId: 'openai', displayName: 'GPT', version: 1, updatedAt }),
    }
}

beforeEach(() => {
    mockDb.db = {}
    state.responders = {}
})

describe('fetchRemoteRegistry', () => {
    it('builds an entry from index + files', async () => {
        setupHappyResponders(1234)
        const res = await fetchRemoteRegistry()
        expect(res.ok).toBe(true)
        expect(res.gate).toBe(1234)
        expect(res.entry?.profiles?.['openai:gpt']).toBeTruthy()
        expect(res.entry?.baseProviders?.['openai']).toBeTruthy()
    })

    it('rejects an unsupported schemaVersion (keeps fallback)', async () => {
        setupHappyResponders(1, { schemaVersion: 3 })
        const res = await fetchRemoteRegistry()
        expect(res.ok).toBe(false)
        expect(res.entry).toBeUndefined()
    })

    it('skips profiles whose base provider is unavailable, then fails if none usable', async () => {
        setupHappyResponders(1, { orphanProfile: true })
        const res = await fetchRemoteRegistry()
        expect(res.ok).toBe(false)
    })
})

describe('isRefetchGuarded', () => {
    it('is false when never fetched', () => {
        expect(isRefetchGuarded(undefined)).toBe(false)
    })
    it('is true within the guard window, false outside', () => {
        expect(isRefetchGuarded(Date.now() - 1000)).toBe(true)
        expect(isRefetchGuarded(Date.now() - 60_000)).toBe(false)
    })
})

describe('syncRemoteRegistry', () => {
    it('writes the cache on first sync and preserves the custom registry', async () => {
        mockDb.db.modelProfileRegistryCache = {
            schemaVersion: 4,
            registries: { custom: { fetchedAt: 0, profiles: { 'custom::x': { id: 'custom::x' } } } },
        }
        setupHappyResponders(2000)
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(true)
        expect(res.changed).toBe(true)
        const regs = mockDb.db.modelProfileRegistryCache.registries
        expect(regs[getBundledRegistryId()]?.profiles?.['openai:gpt']).toBeTruthy()
        expect(regs.custom?.profiles?.['custom::x']).toBeTruthy() // preserved
        expect(mockDb.db.modelProfileRegistryIndexUpdatedAt).toBe(2000)
    })

    it('still persists fresh data when the gate is unchanged (self-heal), but reports changed=false', async () => {
        // A stale/incomplete cache with a matching gate must not be stranded:
        // the freshly-fetched entry is always written. The gate only governs
        // the user-facing "changed" notification.
        mockDb.db.modelProfileRegistryIndexUpdatedAt = 2000
        setupHappyResponders(2000)
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(true)
        expect(res.changed).toBe(false)
        const regs = mockDb.db.modelProfileRegistryCache?.registries
        expect(regs?.[getBundledRegistryId()]?.profiles?.['openai:gpt']).toBeTruthy()
        expect(mockDb.db.modelProfileRegistryIndexUpdatedAt).toBe(2000)
    })

    it('debounces a recent fetch', async () => {
        mockDb.db.modelProfileRegistryLastFetched = Date.now()
        setupHappyResponders(3000)
        const res = await syncRemoteRegistry()
        expect(res.changed).toBe(false)
    })

    it('reports failure without throwing on a bad schema', async () => {
        setupHappyResponders(1, { schemaVersion: 9 })
        const res = await syncRemoteRegistry()
        expect(res.ok).toBe(false)
        expect(mockDb.db.modelProfileRegistryCache).toBeUndefined()
    })
})

describe('getOfficialRegistry', () => {
    it('falls back to the bundled registry when no remote cache', () => {
        const reg = getOfficialRegistry()
        const profiles = reg.registries[getBundledRegistryId()]?.profiles ?? {}
        expect(Object.keys(profiles).length).toBe(
            Object.keys(loadBundledRegistry().registries[getBundledRegistryId()]?.profiles ?? {}).length,
        )
    })

    it('returns the remote entry when present', () => {
        mockDb.db.modelProfileRegistryCache = {
            schemaVersion: 4,
            registries: {
                [getBundledRegistryId()]: { fetchedAt: 1, profiles: { 'openai:gpt': { id: 'openai:gpt' } }, baseProviders: {} },
                custom: { fetchedAt: 0, profiles: { 'custom::x': { id: 'custom::x' } } },
            },
        }
        const reg = getOfficialRegistry()
        // scoped to the official entry only — custom must not leak in
        expect(Object.keys(reg.registries)).toEqual([getBundledRegistryId()])
        expect(reg.registries[getBundledRegistryId()]?.profiles?.['openai:gpt']).toBeTruthy()
    })
})
