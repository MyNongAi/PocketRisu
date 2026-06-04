import { describe, expect, it, vi } from 'vitest'

// localizeDisplayName reads DBState.db.language; an empty db resolves to en.
vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: {} } }))

import { buildSeenMap, computeRegistryNotice, noticeCount } from './notice'
import { getBundledRegistryId } from './loader'
import type { RegistryCache } from '../types'

function official(profiles: Record<string, { updatedAt?: number }>): RegistryCache {
    const entries: Record<string, any> = {}
    for (const [id, p] of Object.entries(profiles)) {
        entries[id] = { id, displayName: id, updatedAt: p.updatedAt }
    }
    return {
        schemaVersion: 4,
        registries: { [getBundledRegistryId()]: { fetchedAt: 0, profiles: entries } },
    }
}

describe('buildSeenMap', () => {
    it('maps profile id -> updatedAt (0 when missing)', () => {
        const map = buildSeenMap(official({ a: { updatedAt: 5 }, b: {} }))
        expect(map).toEqual({ a: 5, b: 0 })
    })
})

describe('computeRegistryNotice', () => {
    it('returns empty when no baseline (first run)', () => {
        const n = computeRegistryNotice(official({ a: { updatedAt: 1 } }), undefined)
        expect(noticeCount(n)).toBe(0)
    })

    it('flags ids absent from seen as new', () => {
        const n = computeRegistryNotice(official({ a: { updatedAt: 1 }, b: { updatedAt: 2 } }), { a: 1 })
        expect(n.newProfiles.map((p) => p.id)).toEqual(['b'])
        expect(n.updatedProfiles).toEqual([])
    })

    it('flags ids with a higher updatedAt as updated', () => {
        const n = computeRegistryNotice(official({ a: { updatedAt: 5 } }), { a: 1 })
        expect(n.updatedProfiles.map((p) => p.id)).toEqual(['a'])
        expect(n.newProfiles).toEqual([])
    })

    it('ignores unchanged profiles', () => {
        const n = computeRegistryNotice(official({ a: { updatedAt: 5 } }), { a: 5 })
        expect(noticeCount(n)).toBe(0)
    })
})
