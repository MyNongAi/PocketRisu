import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

const {
    createSqliteManifestStore,
    DEFAULT_MANIFEST_KEY,
    DEFAULT_LEGACY_ARCHIVE_KEY,
} = require('./external-asset-manifest-store.cjs')

function makeDb() {
    const db = new Database(':memory:')
    db.exec(`
        CREATE TABLE kv (
            key TEXT PRIMARY KEY,
            value BLOB NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `)
    return db
}

function hash(index: number) {
    return index.toString(16).padStart(64, '0')
}

function entry(index: number, overrides: Record<string, unknown> = {}) {
    const uri = `external://local/${hash(index)}`
    return {
        uri,
        providerId: 'local',
        hash: hash(index),
        size: index + 10,
        status: 'staged',
        ...overrides,
    }
}

describe('SQLite external asset manifest store', () => {
    it('losslessly migrates and archives the legacy monolithic JSON', async () => {
        const db = makeDb()
        const legacyEntry = entry(1, {
            fallbacks: [{ internalKey: 'assets/one.png', trashPath: 'one.bin' }],
            migrationIds: ['migration-a'],
        })
        const legacy = {
            version: 1,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-02T00:00:00.000Z',
            assets: { [legacyEntry.uri]: legacyEntry },
        }
        const raw = Buffer.from(JSON.stringify(legacy))
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 1)').run(DEFAULT_MANIFEST_KEY, raw)

        const store = createSqliteManifestStore({ db })

        expect(await store.get(legacyEntry.uri)).toEqual(legacyEntry)
        expect(store.findByInternalKeySync('assets/one.png')).toEqual(legacyEntry)
        expect(store.statsSync()).toMatchObject({
            count: 1,
            bytes: 11,
            fallback: 1,
            migrationIds: ['migration-a'],
            providerIds: ['local'],
        })
        expect(db.prepare('SELECT value FROM kv WHERE key = ?').get(DEFAULT_MANIFEST_KEY)).toBeUndefined()
        expect(db.prepare('SELECT value FROM kv WHERE key = ?').get(DEFAULT_LEGACY_ARCHIVE_KEY).value).toEqual(raw)
        expect(JSON.parse(store.exportBufferSync().toString())).toEqual(legacy)
        expect(store.exportByteLengthSync()).toBe(store.exportBufferSync().length)
        db.close()
    })

    it('gets and updates one entry without decoding an all-assets blob', async () => {
        const db = makeDb()
        const store = createSqliteManifestStore({ db, now: () => '2026-08-10T00:00:00.000Z' })
        const values = Array.from({ length: 10_000 }, (_, index) => {
            const value = entry(index)
            return { uri: value.uri, value }
        })
        store.upsertManyValuesSync(values)

        const target = entry(9_999)
        expect(await store.get(target.uri)).toEqual(target)
        await store.upsert(target.uri, (current: any) => ({ ...current, status: 'verified', lastVerifiedAt: 'now' }))

        expect((await store.get(target.uri)).status).toBe('verified')
        expect(store.statsSync()).toMatchObject({ count: 10_000, verified: 1 })
        expect(db.prepare('SELECT COUNT(*) AS count FROM kv').get().count).toBe(0)
        db.close()
    })

    it('replaces atomically and keeps the previous rows when validation fails', () => {
        const db = makeDb()
        const store = createSqliteManifestStore({ db })
        const original = entry(3)
        store.upsertManyValuesSync([{ uri: original.uri, value: original }])

        expect(() => store.replaceManifestSync({
            version: 1,
            assets: {
                [entry(4).uri]: entry(4),
                broken: { size: -1 },
            },
        })).toThrow()

        expect(store.listSync()).toEqual([original])
        db.close()
    })

    it('maintains fallback and migration indexes across replacement and removal', async () => {
        const db = makeDb()
        const store = createSqliteManifestStore({ db })
        const value = entry(5, {
            fallbacks: [{ internalKey: 'assets/five.webp' }],
            migrationId: 'old-job',
        })
        await store.upsert(value.uri, value)
        expect(store.findByInternalKeySync('assets/five.webp')?.uri).toBe(value.uri)
        expect(store.statsSync().migrationIds).toEqual(['old-job'])

        await store.upsert(value.uri, (current: any) => ({ ...current, fallbacks: [], migrationIds: ['new-job'], migrationId: undefined }))
        expect(store.findByInternalKeySync('assets/five.webp')).toBeNull()
        expect(store.statsSync().migrationIds).toEqual(['new-job'])
        expect(await store.remove(value.uri)).toBe(true)
        expect(store.statsSync().count).toBe(0)
        db.close()
    })
})
