import { describe, expect, it, vi } from 'vitest'
import type { folder } from './storage/database.svelte'
import { applyModuleAssetHealth, characterAssetReferences, countAssetHealth, moduleAssetOwners, moduleHealthKey, planSourceSort, sourceSortFolders, type AssetHealthCount } from './assetHealthSort'

const folder = (name: string, data: string[]): folder => ({ id: name, name, data, color: '' })
const health = (missing: number, total: number, unknown = 0): AssetHealthCount => ({ missing, total, unknown })

describe('characterAssetReferences', () => {
    it('lists every checkable slot, the way the Realm recovery sees them', () => {
        expect(characterAssetReferences({
            chaId: 'c',
            image: 'external://main-assets/aa',
            emotionImages: [['joy', 'assets/joy.png']],
            additionalAssets: [['bg', 'assets/bg.png', 'png'], ['web', 'https://example.test/x.png', 'png']],
            ccAssets: [{ uri: 'assets/cc.png' }, { uri: 'ccdefault:' }],
        })).toEqual(['external://main-assets/aa', 'assets/joy.png', 'assets/bg.png', 'assets/cc.png'])
    })
})

describe('countAssetHealth', () => {
    it('asks once per distinct reference in batches and counts per card', async () => {
        const inspect = vi.fn(async (paths: string[]) => paths.map((path) => ({ path, status: path.includes('gone') ? 'missing' : 'exists' })))
        const counts = await countAssetHealth([
            { chaId: 'a', image: 'assets/ok.png', additionalAssets: [['x', 'assets/gone1.png', 'png'], ['y', 'assets/gone2.png', 'png']] },
            { chaId: 'b', image: 'assets/ok.png', additionalAssets: [['x', 'assets/gone1.png', 'png']] },
        ], inspect, { batchSize: 2 })
        expect(inspect.mock.calls.flatMap(([paths]) => paths).sort()).toEqual(['assets/gone1.png', 'assets/gone2.png', 'assets/ok.png'])
        expect(inspect).toHaveBeenCalledTimes(2)
        expect(counts.get('a')).toEqual(health(2, 3))
        expect(counts.get('b')).toEqual(health(1, 2))
    })

    it('counts a lazy additional-asset list from its manifest, and leaves a card whose list cannot be read uncounted', async () => {
        const inspect = vi.fn(async (paths: string[]) => paths.map((path) => ({ path, status: path.includes('gone') ? 'missing' : 'exists' })))
        const loadAdditionalAssets = vi.fn(async (character: { chaId: string }) => {
            if (character.chaId === 'unreadable') throw new Error('manifest 404')
            return [['a', 'assets/gone-a.png', 'png'], ['b', 'assets/ok-b.png', 'png']]
        })
        const counts = await countAssetHealth([
            { chaId: 'lazy', image: 'assets/ok.png', additionalAssetManifest: { id: 'm1' } },
            { chaId: 'unreadable', image: 'assets/ok.png', additionalAssetManifest: { id: 'm2' } },
            { chaId: 'plain', image: 'assets/ok.png' },
        ], inspect, { loadAdditionalAssets })
        expect(counts.get('lazy')).toEqual(health(1, 3))
        expect(counts.has('unreadable')).toBe(false)
        expect(counts.get('plain')).toEqual(health(0, 1))
    })

    it('never guesses a lazy list it was given no way to read', async () => {
        const counts = await countAssetHealth([{ chaId: 'lazy', image: 'assets/ok.png', additionalAssetManifest: { id: 'm1' } }],
            async (paths) => paths.map((path) => ({ path, status: 'exists' })))
        expect(counts.size).toBe(0)
    })

    it('retries a busy server, and a batch that keeps failing counts as unknown, never missing', async () => {
        let calls = 0
        const inspect = vi.fn(async (paths: string[]) => {
            calls++
            if (paths.includes('assets/flaky.png') && calls === 1) throw new Error('HTTP 429')
            if (paths.includes('assets/broken-link.png')) throw new Error('offline')
            return paths.map((path) => ({ path, status: 'exists' }))
        })
        const counts = await countAssetHealth([
            { chaId: 'a', image: 'assets/flaky.png' },
            { chaId: 'b', image: 'assets/broken-link.png' },
        ], inspect, { batchSize: 1, concurrency: 1, attempts: 3, sleep: async () => {} })
        expect(counts.get('a')).toEqual(health(0, 1))
        expect(counts.get('b')).toEqual(health(0, 1, 1))
    })
})

describe('planSourceSort', () => {
    const label = '모바일웹리스'
    const names = sourceSortFolders(label)
    const card = (chaId: string, name = chaId, extra: Record<string, unknown> = {}) => ({ chaId, name, sourceInfo: { label }, ...extra })

    it('sorts top-level and source-folder cards into the four folders and leaves other folders alone', () => {
        const order = [
            'restored', 'never-broken', 'half-restored',
            folder(names.healthy, ['healthy', 'blank']),
            folder('[유사 후보] Same · 2개 · 모바일웹리스', ['duplicate']),
            folder('프로톤', ['proton']),
            'local',
        ]
        const characters = [
            card('restored', 'Restored', { realmId: 'r1' }),
            card('never-broken'),
            card('half-restored', 'Half', { realmId: 'r2' }),
            card('healthy'),
            card('blank', ''),
            card('duplicate'),
            card('proton'),
            { chaId: 'local', name: 'Local', sourceInfo: { label: '로컬리스' } },
        ]
        const counts = new Map([
            ['restored', health(0, 10)], ['never-broken', health(0, 3)], ['half-restored', health(9, 10)],
            ['healthy', health(0, 2)], ['blank', health(0, 0)], ['duplicate', health(5, 5)], ['proton', health(7, 7)],
            ['local', health(1, 1)],
        ])
        const plan = planSourceSort({ label, order, characters, health: counts, hasRealmId: (c) => Boolean((c as { realmId?: string }).realmId) })
        expect(Object.fromEntries(plan.assignments)).toEqual({
            'restored': names.recovered,
            'never-broken': names.healthy,
            'half-restored': names.missing,
            'blank': names.empty,
        })
        expect(plan.counts).toEqual({ healthy: 2, recovered: 1, missing: 1, empty: 1 })
    })

    it('leaves a card whose check was inconclusive where it is', () => {
        const plan = planSourceSort({
            label, order: ['card'], characters: [card('card')],
            health: new Map([['card', health(0, 4, 2)]]), hasRealmId: () => true,
        })
        expect(plan.assignments.size).toBe(0)
    })
})

describe('module asset health', () => {
    type TestModule = { id: string, name: string, assets?: unknown, assetManifest?: unknown, sourceInfo?: { label?: string, missingAssetCount?: number, assetReferenceCount?: number } }
    const mod = (id: string, extra: Partial<TestModule> = {}): TestModule => ({ id, name: id, ...extra })
    const info = (missingAssetCount: number, assetReferenceCount = missingAssetCount) => ({ label: '모바일웹리스', missingAssetCount, assetReferenceCount })

    it('counts the modules that carry an import record, by their asset list or its manifest', () => {
        const owners = moduleAssetOwners([
            mod('plain', { sourceInfo: info(1), assets: [['a', 'assets/a.png', 'png']] }),
            mod('lazy', { sourceInfo: info(0), assetManifest: { id: 'm' } }),
            mod('unsourced', { assets: [['a', 'assets/a.png', 'png']] }),
            null,
        ])
        expect(owners.map((owner) => owner.chaId)).toEqual([moduleHealthKey('plain'), moduleHealthKey('lazy')])
        expect(owners[0].additionalAssets).toEqual([['a', 'assets/a.png', 'png']])
        expect(owners[1]).toMatchObject({ additionalAssets: undefined, additionalAssetManifest: { id: 'm' } })
    })

    it('writes the recount: a module with no assets loses its red, one whose files are gone keeps it at the real number', async () => {
        const inspect = vi.fn(async (paths: string[]) => paths.map((path) => ({ path, status: path.includes('gone') ? 'missing' : 'exists' })))
        const modules = [
            mod('empty', { sourceInfo: info(1, 1) }),
            mod('broken', { sourceInfo: info(1, 1), assets: [['a', 'assets/gone-a.png', 'png'], ['b', 'assets/gone-b.png', 'png']] }),
            mod('fine', { sourceInfo: info(0, 1), assets: [['a', 'external://main-assets/ok', 'png']] }),
            mod('unsourced', { assets: [['a', 'assets/gone-c.png', 'png']] }),
        ]
        const counts = await countAssetHealth(moduleAssetOwners(modules), inspect)
        const result = applyModuleAssetHealth(modules, counts)
        expect(result).toMatchObject({ checked: 3, changed: 2, unknown: 0 })
        expect(result.modules.map((module) => module.sourceInfo?.missingAssetCount)).toEqual([0, 2, 0, undefined])
        expect(result.modules[1].sourceInfo).toMatchObject({ label: '모바일웹리스', assetReferenceCount: 2 })
        // Only the changed modules are new objects.
        expect(result.modules[0]).not.toBe(modules[0])
        expect(result.modules[2]).toBe(modules[2])
        expect(result.modules[3]).toBe(modules[3])
    })

    it('keeps the old record when a check failed and nothing is surely missing', () => {
        const modules = [mod('a', { sourceInfo: info(5, 5) })]
        const result = applyModuleAssetHealth(modules, new Map([[moduleHealthKey('a'), health(0, 5, 5)]]))
        expect(result).toMatchObject({ checked: 1, changed: 0, unknown: 5 })
        expect(result.modules[0]).toBe(modules[0])
    })

    it('never takes a card count for a module of the same id', () => {
        const modules = [mod('same', { sourceInfo: info(3, 3) })]
        const result = applyModuleAssetHealth(modules, new Map([['same', health(0, 3)]]))
        expect(result.checked).toBe(0)
        expect(result.modules[0]).toBe(modules[0])
    })
})
