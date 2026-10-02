import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import journalPkg from './import-asset-journal.cjs'
import externalPkg from './external-assets.cjs'

const { createImportAssetJournal, isImportId } = journalPkg as any
const {
    createExternalAssetService,
    createFilesystemProvider,
    createManifestStore,
    makeExternalAssetUri,
    sha256,
} = externalPkg as any

const IMPORT_A = '11111111-1111-4111-8111-111111111111'
const IMPORT_B = '22222222-2222-4222-8222-222222222222'
const EXT = (n: number) => `external://main/${String(n).repeat(64).slice(0, 64)}`

const tempDirs: string[] = []
afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fakeStore(initial: string[] = []) {
    const keys = new Set(initial)
    return {
        keys,
        removeInternal: vi.fn((list: string[]) => { for (const key of list) keys.delete(key) }),
        removeExternal: vi.fn(async (key: string) => keys.delete(key)),
    }
}

describe('import asset journal', () => {
    it('accepts only UUID import ids', () => {
        expect(isImportId(IMPORT_A)).toBe(true)
        expect(isImportId('../assets')).toBe(false)
        const journal = createImportAssetJournal()
        expect(() => journal.begin('nope')).toThrow('Invalid import id')
    })

    it('removes what the import created and keeps objects that existed before', async () => {
        const journal = createImportAssetJournal()
        journal.begin(IMPORT_A)
        journal.recordWrite('assets/new.png', IMPORT_A, true)
        journal.recordWrite(EXT(1), IMPORT_A, true)
        // Dedup hit: another bot already had this image.
        journal.recordWrite('assets/old.png', IMPORT_A, false)
        journal.recordWrite(EXT(2), IMPORT_A, false)
        const store = fakeStore(['assets/new.png', EXT(1), 'assets/old.png', EXT(2)])

        const result = await journal.rollback(IMPORT_A, { isReferenced: () => false, ...store })

        expect(result).toMatchObject({ removed: 2, kept: 2, reused: 2 })
        expect([...store.keys].sort()).toEqual(['assets/old.png', EXT(2)].sort())
        expect(store.removeInternal).toHaveBeenCalledWith(['assets/new.png'])
        expect(store.removeExternal).toHaveBeenCalledTimes(1)
    })

    it('keeps an object another writer touched after the import created it', async () => {
        const journal = createImportAssetJournal()
        journal.begin(IMPORT_A)
        journal.begin(IMPORT_B)
        journal.recordWrite('assets/a.png', IMPORT_A, true)
        journal.recordWrite(EXT(1), IMPORT_A, true)
        journal.recordWrite(EXT(2), IMPORT_A, true)
        // An untagged save (a chat image, another device) wrote the same content…
        journal.recordWrite('assets/a.png', undefined, false)
        // …and a second import deduplicated onto this one's new object.
        journal.recordWrite(EXT(1), IMPORT_B, false)
        const store = fakeStore(['assets/a.png', EXT(1), EXT(2)])

        const result = await journal.rollback(IMPORT_A, { isReferenced: () => false, ...store })

        expect(result.removed).toBe(1)
        expect(result.reasons).toEqual({ shared: 2 })
        expect([...store.keys].sort()).toEqual(['assets/a.png', EXT(1)].sort())
    })

    it('keeps objects the saved database still references', async () => {
        const journal = createImportAssetJournal()
        journal.begin(IMPORT_A)
        journal.recordWrite('assets/a.png', IMPORT_A, true)
        journal.recordWrite(EXT(1), IMPORT_A, true)
        const store = fakeStore(['assets/a.png', EXT(1)])

        const result = await journal.rollback(IMPORT_A, {
            isReferenced: (key: string) => key === EXT(1),
            ...store,
        })

        expect(result).toMatchObject({ removed: 1, kept: 1, reasons: { referenced: 1 } })
        expect([...store.keys]).toEqual([EXT(1)])
    })

    it('deletes nothing when the reference scan failed or a storage-wide operation ran', async () => {
        const failedScan = createImportAssetJournal()
        failedScan.begin(IMPORT_A)
        failedScan.recordWrite('assets/a.png', IMPORT_A, true)
        const store = fakeStore(['assets/a.png'])
        expect(await failedScan.rollback(IMPORT_A, { isReferenced: null, ...store }))
            .toMatchObject({ removed: 0, kept: 1, reasons: { 'reference-scan-failed': 1 } })

        const migrated = createImportAssetJournal()
        migrated.begin(IMPORT_A)
        migrated.recordWrite('assets/a.png', IMPORT_A, true)
        migrated.markUnsafe('backup import')
        expect(await migrated.rollback(IMPORT_A, { isReferenced: () => false, ...store }))
            .toMatchObject({ removed: 0, kept: 1, reasons: { unsafe: 1 } })
        expect(store.removeInternal).not.toHaveBeenCalled()
        expect(store.keys.has('assets/a.png')).toBe(true)
    })

    it('never deletes an object two imports both created', async () => {
        const journal = createImportAssetJournal()
        journal.begin(IMPORT_A)
        journal.begin(IMPORT_B)
        journal.recordWrite(EXT(1), IMPORT_A, true)
        // Something deleted it in between (orphan purge), then B wrote it anew.
        journal.recordWrite(EXT(1), IMPORT_B, true)
        const store = fakeStore([EXT(1)])

        expect((await journal.rollback(IMPORT_B, { isReferenced: () => false, ...store })).removed).toBe(0)
        expect((await journal.rollback(IMPORT_A, { isReferenced: () => false, ...store })).removed).toBe(0)
        expect(store.keys.has(EXT(1))).toBe(true)
    })

    it('refuses late writes of a finished import and forgets nothing it should keep', async () => {
        const journal = createImportAssetJournal()
        journal.begin(IMPORT_A)
        journal.recordWrite('assets/a.png', IMPORT_A, true)
        await journal.rollback(IMPORT_A, { isReferenced: () => false, ...fakeStore() })
        expect(journal.isClosed(IMPORT_A)).toBe(true)
        expect(() => journal.begin(IMPORT_A)).toThrow('already finished')

        journal.begin(IMPORT_B)
        journal.commit(IMPORT_B)
        expect(journal.isClosed(IMPORT_B)).toBe(true)
        expect(journal.stats()).toMatchObject({ open: 0, tracked: 0 })
    })

    it('a forgotten journal (restart, expiry) deletes nothing', async () => {
        let time = 0
        const journal = createImportAssetJournal({ now: () => time, ttlMs: 1000 })
        journal.begin(IMPORT_A)
        journal.recordWrite('assets/a.png', IMPORT_A, true)
        time = 5000
        journal.begin(IMPORT_B) // expiry runs on begin
        const store = fakeStore(['assets/a.png'])
        const result = await journal.rollback(IMPORT_A, { isReferenced: () => false, ...store })
        expect(result).toMatchObject({ removed: 0, unknown: true })
        expect(store.keys.has('assets/a.png')).toBe(true)
    })

    it('a write holding the key lock when the delete comes keeps the object', async () => {
        const journal = createImportAssetJournal()
        journal.begin(IMPORT_A)
        journal.recordWrite(EXT(1), IMPORT_A, true)
        const keys = new Set([EXT(1)])
        let releaseWrite!: () => void
        // A foreign write of the same bytes is storing them right now.
        const writing = journal.withKeyLock(EXT(1), async () => {
            await new Promise<void>((resolve) => { releaseWrite = resolve })
            journal.recordWrite(EXT(1), undefined, false)
        })
        await Promise.resolve()
        const rollingBack = journal.rollback(IMPORT_A, {
            isReferenced: () => false,
            removeInternal: () => {},
            removeExternal: async (key: string) => keys.delete(key),
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
        releaseWrite()
        expect(await rollingBack).toMatchObject({ removed: 0, reasons: { shared: 1 } })
        await writing
        expect(keys.has(EXT(1))).toBe(true)
    })

    it('a write arriving during the delete waits for it and stores the bytes again', async () => {
        const journal = createImportAssetJournal()
        journal.begin(IMPORT_A)
        journal.recordWrite(EXT(1), IMPORT_A, true)
        const order: string[] = []
        const keys = new Set([EXT(1)])
        let deleting!: () => void
        let finishDelete!: () => void
        const started = new Promise<void>((resolve) => { deleting = resolve })
        const rollingBack = journal.rollback(IMPORT_A, {
            isReferenced: () => false,
            removeInternal: () => {},
            removeExternal: async (key: string) => {
                deleting()
                await new Promise<void>((resolve) => { finishDelete = resolve })
                order.push('remove')
                return keys.delete(key)
            },
        })
        await started
        const writing = journal.withKeyLock(EXT(1), async () => {
            order.push('write')
            keys.add(EXT(1))
            journal.recordWrite(EXT(1), undefined, true)
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(order).toEqual([])
        finishDelete()
        expect(await rollingBack).toMatchObject({ removed: 1 })
        await writing
        expect(order).toEqual(['remove', 'write'])
        expect(keys.has(EXT(1))).toBe(true)
    })

    it('runs the reference scan and internal deletes inside the storage queue, external deletes after it', async () => {
        const journal = createImportAssetJournal()
        journal.begin(IMPORT_A)
        journal.recordWrite('assets/a.png', IMPORT_A, true)
        journal.recordWrite(EXT(1), IMPORT_A, true)
        const events: string[] = []
        await journal.rollback(IMPORT_A, {
            storageQueue: async (operation: () => Promise<unknown>) => {
                events.push('queue in')
                const value = await operation()
                events.push('queue out')
                return value
            },
            referenceCheck: async () => { events.push('scan'); return () => false },
            removeInternal: () => { events.push('internal') },
            removeExternal: async () => { events.push('external'); return true },
        })
        expect(events).toEqual(['queue in', 'scan', 'internal', 'queue out', 'external'])
    })
})

describe('external objects created by an import', () => {
    function service() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-journal-'))
        tempDirs.push(root)
        const values = new Map<string, Buffer>()
        const manifestStore = createManifestStore({
            getValue: async (key: string) => values.get(key) ?? null,
            setValue: async (key: string, value: Buffer) => values.set(key, Buffer.from(value)),
        })
        const provider = createFilesystemProvider({ id: 'main', rootDir: path.join(root, 'store') })
        return {
            provider,
            manifestStore,
            service: createExternalAssetService({ providers: [provider], manifestStore, retry: { attempts: 1 } }),
        }
    }

    it('reports created only for content that did not exist', async () => {
        const { service: assets } = service()
        const data = Buffer.from('portrait')
        expect((await assets.writeDirect({ providerId: 'main', data })).created).toBe(true)
        expect((await assets.writeDirect({ providerId: 'main', data })).created).toBe(false)
    })

    it('rolls back a new object and keeps one that already existed', async () => {
        const { service: assets, provider, manifestStore } = service()
        const journal = createImportAssetJournal()
        const shared = Buffer.from('used by another bot already')
        const fresh = Buffer.from('only in the cancelled card')
        const sharedUri = (await assets.writeDirect({ providerId: 'main', data: shared })).uri

        journal.begin(IMPORT_A)
        for (const data of [shared, fresh]) {
            const uri = makeExternalAssetUri('main', sha256(data))
            await journal.withKeyLock(uri, async () => {
                const written = await assets.writeDirect({ providerId: 'main', data })
                journal.recordWrite(written.uri, IMPORT_A, written.created)
            })
        }
        const freshUri = makeExternalAssetUri('main', sha256(fresh))

        const result = await journal.rollback(IMPORT_A, {
            isReferenced: () => false,
            removeInternal: () => {},
            removeExternal: async (uri: string) => (await assets.discardImported(uri)).removed,
        })

        expect(result).toMatchObject({ removed: 1, kept: 1, reused: 1 })
        await expect(provider.get(sha256(fresh))).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' })
        expect(await manifestStore.get(freshUri)).toBeNull()
        expect(await provider.get(sha256(shared))).toEqual(shared)
        expect(await manifestStore.get(sharedUri)).toMatchObject({ status: 'verified' })
        // The same bytes can be imported again later.
        expect((await assets.writeDirect({ providerId: 'main', data: fresh })).created).toBe(true)
    })

    it('does not discard objects that carry migration recovery copies', async () => {
        const { service: assets, manifestStore, provider } = service()
        const data = Buffer.from('migrated earlier')
        const { uri, hash } = await assets.writeDirect({ providerId: 'main', data })
        await manifestStore.upsert(uri, (old: any) => ({ ...old, fallbacks: [{ internalKey: 'assets/x.png', trashPath: 'a/b' }] }))
        expect(await assets.discardImported(uri)).toEqual({ removed: false, reason: 'has-fallbacks' })
        expect(await provider.get(hash)).toEqual(data)
    })
})
