import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { Packr } from 'msgpackr'
import storePkg from './assetManifestStore.cjs'
import migrationPkg from './assetManifestMigration.cjs'

const { createAssetManifestStore } = storePkg as any
const { stripAssetManifests, hydrateAssetManifests, assetManifestSummary } = migrationPkg as any
const zlib = createRequire(import.meta.url)('zlib')

function freshStore() {
    return createAssetManifestStore(new Database(':memory:'))
}

// ---- oracle: verbatim copy of loadDescriptorItems / hydrateAssetManifests at
// 9fda95786, which verified and then loaded every manifest (two decodes) ----
function loadDescriptorItemsOracle(store, descriptor) {
    if (!descriptor?.id) throw new Error('Asset manifest descriptor is missing an id');
    const verified = store.verifyManifest(descriptor.id);
    if (!verified.ok) throw new Error(`Asset manifest is unavailable or corrupt: ${descriptor.id}`);
    if (descriptor.version !== undefined && verified.version !== descriptor.version) {
        throw new Error(`Asset manifest version mismatch: ${descriptor.id}`);
    }
    if (descriptor.count !== undefined && verified.count !== descriptor.count) {
        throw new Error(`Asset manifest count mismatch: ${descriptor.id}`);
    }
    if (descriptor.sha256 && verified.sha256 !== descriptor.sha256) {
        throw new Error(`Asset manifest hash mismatch: ${descriptor.id}`);
    }
    if (descriptor.ownerKind && verified.ownerKind !== descriptor.ownerKind) {
        throw new Error(`Asset manifest owner kind mismatch: ${descriptor.id}`);
    }
    if (descriptor.ownerId && verified.ownerId !== descriptor.ownerId) {
        throw new Error(`Asset manifest owner id mismatch: ${descriptor.id}`);
    }
    return store.loadItems(descriptor.id);
}

function hydrateAssetManifestsOracle(dbObj, store) {
    if (!dbObj || typeof dbObj !== 'object') return dbObj;
    const out = { ...dbObj };

    if (Array.isArray(dbObj.modules)) {
        out.modules = dbObj.modules.map((module) => {
            if (!module?.assetManifest) return module;
            const next = { ...module, assets: loadDescriptorItemsOracle(store, module.assetManifest) };
            delete next.assetManifest;
            return next;
        });
    }

    if (Array.isArray(dbObj.characters)) {
        out.characters = dbObj.characters.map((character) => {
            if (!character?.additionalAssetManifest) return character;
            const next = {
                ...character,
                additionalAssets: loadDescriptorItemsOracle(store, character.additionalAssetManifest),
            };
            delete next.additionalAssetManifest;
            return next;
        });
    }

    if (Array.isArray(dbObj.personas)) {
        out.personas = dbObj.personas.map((persona) => {
            const embedded = persona?.embeddedModule;
            if (!embedded?.assetManifest) return persona;
            const nextEmbedded = { ...embedded, assets: loadDescriptorItemsOracle(store, embedded.assetManifest) };
            delete nextEmbedded.assetManifest;
            return { ...persona, embeddedModule: nextEmbedded };
        });
    }

    return out;
}

function mixedSource() {
    const tuples = (prefix: string, n: number) => Array.from({ length: n }, (_, i) =>
        i % 3 === 0 ? [`${prefix} ${i}`, `assets/${prefix}${i}`] : [`${prefix}-${i}.png`, `assets/${prefix}${i}.png`, i % 3 === 1 ? 'png' : null])
    return {
        formatversion: 3,
        modules: [
            { id: 'm1', name: 'Pack', assets: tuples('m1', 40), lorebook: [] },
            { namespace: 'ns-only', assets: tuples('ns', 5), trigger: [] },
            { id: 'm-empty', assets: [] },
            { id: 'm-none', name: 'no assets' },
            null,
        ],
        characters: [
            { chaId: 'c1', name: '캐릭터', additionalAssets: tuples('c1', 25), chats: [] },
            { chaId: 'c2', name: 'no extra assets', chats: [] },
            { name: 'no chaId', additionalAssets: tuples('anon', 3) },
        ],
        personas: [
            { id: 'p1', name: 'persona', embeddedModule: { id: 'pm', assets: tuples('p1', 7), lorebook: [] } },
            { id: 'p2', name: 'plain persona' },
        ],
        botPresets: [{ id: 'preset', name: 'preset' }],
    }
}

const packr = new Packr({ useRecords: false })
// Same bytes as encodeRisuSaveLegacy minus its header: key order counts too.
function expectSameEncoding(actual: unknown, expected: unknown) {
    expect(Buffer.compare(Buffer.from(packr.encode(actual)), Buffer.from(packr.encode(expected)))).toBe(0)
}

function errorMessage(run: () => unknown) {
    try {
        run()
    } catch (error) {
        return String((error as Error)?.message)
    }
    return null
}

describe('asset manifest migration compatibility layer', () => {
    it('strips module, character and embedded persona arrays without mutating source', () => {
        const store = freshStore()
        const source = {
            modules: [{ id: 'm1', name: 'Pack', assets: [['m', 'assets/m.png', 'png']] }],
            characters: [{ chaId: 'c1', name: 'Char', additionalAssets: [['c', 'assets/c.png', 'png']] }],
            personas: [{ id: 'p1', embeddedModule: { id: 'embedded', assets: [['p', 'assets/p.png', 'png']] } }],
        }

        const result = stripAssetManifests(source, store)
        expect(source.modules[0].assets).toHaveLength(1)
        expect(source.characters[0].additionalAssets).toHaveLength(1)
        expect(source.personas[0].embeddedModule.assets).toHaveLength(1)

        expect(result.db.modules[0].assets).toBeUndefined()
        expect(result.db.modules[0].assetManifest).toMatchObject({ ownerKind: 'module', ownerId: 'm1', count: 1 })
        expect(result.db.characters[0].additionalAssets).toBeUndefined()
        expect(result.db.characters[0].additionalAssetManifest).toMatchObject({ ownerKind: 'character', ownerId: 'c1' })
        expect(result.db.personas[0].embeddedModule.assets).toBeUndefined()
        expect(result.migrated).toHaveLength(3)
        expect(assetManifestSummary(result.db)).toMatchObject({ manifests: 3, items: 3 })
    })

    it('hydrates a byte-for-byte JSON-equivalent legacy shape for persistence/export', () => {
        const store = freshStore()
        const source = {
            untouched: { value: true },
            modules: [{ id: 'm1', name: 'Pack', assets: [['A', 'assets/A.PNG', 'PNG'], ['legacy', 'assets/x']] }],
            characters: [{ chaId: 'c1', additionalAssets: [['표정', 'assets/c.webp', 'webp']] }],
            personas: [],
        }

        const stripped = stripAssetManifests(source, store).db
        const hydrated = hydrateAssetManifests(stripped, store)
        expect(hydrated).toEqual(source)
        expect(stripped.modules[0].assetManifest).toBeDefined()
    })

    it('does not externalize empty arrays', () => {
        const store = freshStore()
        const source = {
            modules: [{ id: 'm1', assets: [] }],
            characters: [{ chaId: 'c1', additionalAssets: [] }],
            personas: [],
        }
        const result = stripAssetManifests(source, store)
        expect(result.db).toEqual(source)
        expect(result.migrated).toHaveLength(0)
    })

    it('refuses hydration after manifest corruption instead of dropping assets', () => {
        const db = new Database(':memory:')
        const store = createAssetManifestStore(db, { maxCacheBytes: 0 })
        const source = { modules: [{ id: 'm1', assets: [['a', 'assets/a.png', 'png']] }] }
        const stripped = stripAssetManifests(source, store).db
        db.prepare('UPDATE asset_manifests SET content_hash = ?').run('0'.repeat(64))
        expect(() => hydrateAssetManifests(stripped, store)).toThrow(/unavailable or corrupt/)
    })

    it('treats a descriptor as authoritative over an accidental inline empty array', () => {
        const store = freshStore()
        const source = { modules: [{ id: 'm1', assets: [['safe', 'assets/safe.png', 'png']] }] }
        const stripped = stripAssetManifests(source, store).db
        stripped.modules[0].assets = []
        expect(hydrateAssetManifests(stripped, store)).toEqual(source)
    })

    it('hydrates independent arrays so consumer mutation cannot corrupt later hydrations', () => {
        const store = freshStore()
        const source = { modules: [{ id: 'm1', assets: [['a', 'assets/a.png', 'png']] }] }
        const stripped = stripAssetManifests(source, store).db

        const first = hydrateAssetManifests(stripped, store)
        first.modules[0].assets.push(['injected', 'assets/evil', 'png'])
        first.modules[0].assets[0][0] = 'mutated'

        expect(hydrateAssetManifests(stripped, store)).toEqual(source)
    })

    it('rejects descriptor owner or version tampering', () => {
        const store = freshStore()
        const source = { modules: [{ id: 'm1', assets: [['safe', 'assets/safe.png', 'png']] }] }
        const stripped = stripAssetManifests(source, store).db

        stripped.modules[0].assetManifest.ownerId = 'another-module'
        expect(() => hydrateAssetManifests(stripped, store)).toThrow(/owner id mismatch/)

        stripped.modules[0].assetManifest.ownerId = 'm1'
        stripped.modules[0].assetManifest.version = 999
        expect(() => hydrateAssetManifests(stripped, store)).toThrow(/version mismatch/)
    })
})

describe('hydrateAssetManifests: one decode per manifest', () => {
    it('produces the same database as the previous two-decode implementation', () => {
        const db = new Database(':memory:')
        const source = mixedSource()
        const stripped = stripAssetManifests(source, createAssetManifestStore(db)).db

        const expected = hydrateAssetManifestsOracle(stripped, createAssetManifestStore(db))
        const actual = hydrateAssetManifests(stripped, createAssetManifestStore(db))
        expect(actual).toEqual(expected)
        expectSameEncoding(actual, expected)
        // Again with a warm LRU on the oracle side (its loadItems hits the cache).
        const warm = createAssetManifestStore(db)
        hydrateAssetManifestsOracle(stripped, warm)
        expectSameEncoding(hydrateAssetManifests(stripped, warm), hydrateAssetManifestsOracle(stripped, warm))
        expect(actual).toEqual(source)
    })

    it('decodes each manifest once and leaves the LRU empty', () => {
        const db = new Database(':memory:')
        const source = mixedSource()
        const stripped = stripAssetManifests(source, createAssetManifestStore(db)).db
        const store = createAssetManifestStore(db)

        const inflate = vi.spyOn(zlib, 'inflateRawSync')
        let hydrated
        try {
            hydrated = hydrateAssetManifests(stripped, store)
            expect(inflate).toHaveBeenCalledTimes(5)
        } finally {
            inflate.mockRestore()
        }
        expect(hydrated).toEqual(source)
        expect(store.stats()).toMatchObject({ cacheEntries: 0, cacheRawBytes: 0 })
    })

    it('leaves what interactive lookups cached in place', () => {
        const db = new Database(':memory:')
        const stripped = stripAssetManifests(mixedSource(), createAssetManifestStore(db)).db
        const store = createAssetManifestStore(db)
        const cachedId = stripped.characters[0].additionalAssetManifest.id
        expect(store.getPage(cachedId, { limit: 1 }).total).toBe(25)
        const before = store.stats()

        hydrateAssetManifests(stripped, store)
        expect(store.stats()).toMatchObject({ cacheEntries: before.cacheEntries, cacheRawBytes: before.cacheRawBytes })
        expect(before.cacheEntries).toBe(1)
    })

    it('rejects the same damaged or tampered manifests with the same errors', () => {
        const db = new Database(':memory:')
        const store = createAssetManifestStore(db)
        const stripped = stripAssetManifests(mixedSource(), store).db
        const tamperings: Array<(descriptor: any) => void> = [
            (d) => { d.version = 999 },
            (d) => { d.count += 1 },
            (d) => { d.sha256 = 'f'.repeat(64) },
            (d) => { d.ownerKind = 'character' },
            (d) => { d.ownerId = 'another-module' },
            (d) => { d.id = 'missing' },
            (d) => { delete d.id },
        ]
        for (const tamper of tamperings) {
            const copy = structuredClone(stripped)
            tamper(copy.modules[0].assetManifest)
            const expected = errorMessage(() => hydrateAssetManifestsOracle(copy, store))
            expect(expected).not.toBeNull()
            expect(errorMessage(() => hydrateAssetManifests(copy, store))).toBe(expected)
        }

        const damagedId = stripped.personas[0].embeddedModule.assetManifest.id
        db.prepare('UPDATE asset_manifests SET payload = ? WHERE manifest_id = ?')
            .run(Buffer.from('not-deflate'), damagedId)
        const expected = errorMessage(() => hydrateAssetManifestsOracle(stripped, createAssetManifestStore(db)))
        expect(expected).toMatch(/unavailable or corrupt/)
        expect(errorMessage(() => hydrateAssetManifests(stripped, createAssetManifestStore(db)))).toBe(expected)
    })
})
