import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

const { createChunkStore } = require('./chunkStore.cjs')
const { decodeRisuSave, encodeRisuSaveLegacy } = require('./utils.cjs')
const { createExternalAssetMigrationJournal } = require('./external-asset-migration-journal.cjs')
const { finalizeExternalAssetMigration } = require('./external-asset-finalize-worker.cjs')

function hash(data: Buffer) {
    return createHash('sha256').update(data).digest('hex')
}

describe('external asset finalizer', () => {
    const providerFingerprint = 'provider-fingerprint-test'
    let db: Database.Database | undefined
    let trashDir: string | undefined
    afterEach(() => {
        db?.close()
        if (trashDir) rmSync(trashDir, { recursive: true, force: true })
        trashDir = undefined
    })

    it('merges into the current DB and only drops unshared verified originals', async () => {
        db = new Database(':memory:')
        db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)`)
        const chunks = createChunkStore(db, { threshold: 32 })
        const journal = createExternalAssetMigrationJournal({ db, makeId: () => 'job-1' })
        trashDir = mkdtempSync(join(tmpdir(), 'pocketrisu-finalize-trash-'))
        const removable = Buffer.from('removable')
        const shared = Buffer.from('shared')
        const plugin = Buffer.from('plugin')
        const staleOriginal = Buffer.from('old-stale')
        const items = [
            ['assets/removable.png', removable],
            ['assets/shared.png', shared],
            ['assets/plugin.png', plugin],
            ['assets/stale.png', staleOriginal],
        ] as const
        const originalDb = {
            characters: [{
                chaId: 'c1',
                image: 'assets/removable.png',
                additionalAssets: [
                    ['shared', 'assets/shared.png'],
                    ['plugin', 'assets/plugin.png'],
                    ['stale', 'assets/stale.png'],
                ],
            }],
            customBackground: 'assets/shared.png',
            modules: [],
            personas: [],
            chatsAddedWhileStaging: ['kept'],
        }
        chunks.putValue('database/database.bin', Buffer.from(encodeRisuSaveLegacy(originalDb)))
        const insert = db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 1)')
        for (const [key, value] of items) insert.run(key, value)
        insert.run('cache/plugin-storage/example.json', Buffer.from('{"icon":"assets/plugin.png"}'))

        const job = journal.createJob({
            providerId: 'local',
            databaseHash: 'old-plan-hash',
            items: items.map(([internalKey, value]) => ({ internalKey, size: value.length })),
        })
        for (let ordinal = 0; ordinal < items.length; ordinal++) {
            const [internalKey, value] = items[ordinal]
            const expectedHash = hash(value)
            const trashPath = `job-1/${ordinal}-${expectedHash}`
            mkdirSync(join(trashDir, 'job-1'), { recursive: true })
            writeFileSync(join(trashDir, trashPath), value)
            journal.markItemStaged(job.id, ordinal, {
                uri: `external://local/${expectedHash}`,
                hash: expectedHash,
                size: value.length,
                trashPath,
            })
        }
        journal.updateJobStatus(job.id, 'staged')
        journal.beginStagedVerification(job.id, { providerFingerprint })
        for (let ordinal = 0; ordinal < items.length; ordinal++) {
            const value = items[ordinal][1]
            journal.markItemPrepublishVerified(job.id, ordinal, {
                hash: hash(value),
                size: value.length,
                verifiedAt: '2026-08-25T00:00:00.000Z',
                providerFingerprint,
            })
        }
        expect(journal.completeStagedVerification(job.id, { providerFingerprint }).status).toBe('staged-verified')
        const missingTrash = join(trashDir, `job-1/0-${hash(removable)}`)
        rmSync(missingTrash)
        await expect(finalizeExternalAssetMigration({
            db,
            jobId: job.id,
            chunkStore: chunks,
            journal,
            providerFingerprint,
            trashDir,
        })).rejects.toThrow()
        expect(db.prepare('SELECT 1 FROM kv WHERE key = ?').get('assets/removable.png')).toBeTruthy()
        expect((await decodeRisuSave(chunks.getValue('database/database.bin'))).characters[0].image)
            .toBe('assets/removable.png')
        writeFileSync(missingTrash, removable)
        // Simulate a source being replaced after its external copy was staged.
        db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(Buffer.from('new-stale'), 'assets/stale.png')

        const result = await finalizeExternalAssetMigration({
            db,
            jobId: job.id,
            chunkStore: chunks,
            journal,
            providerFingerprint,
            trashDir,
        })
        expect(result.referencesRewritten).toBe(3)
        expect(result.removedInternalAssets).toBe(1)
        expect(result.retainedInternalAssets).toBe(3)
        expect(result.staleItems).toBe(1)
        expect(db.prepare('SELECT 1 FROM kv WHERE key = ?').get('assets/removable.png')).toBeUndefined()
        expect(db.prepare('SELECT 1 FROM kv WHERE key = ?').get('assets/shared.png')).toBeTruthy()
        expect(db.prepare('SELECT 1 FROM kv WHERE key = ?').get('assets/plugin.png')).toBeTruthy()
        expect(db.prepare('SELECT value FROM kv WHERE key = ?').get('assets/stale.png').value.toString()).toBe('new-stale')

        const decoded = await decodeRisuSave(chunks.getValue('database/database.bin'))
        expect(decoded.characters[0].image).toBe(`external://local/${hash(removable)}`)
        expect(decoded.characters[0].additionalAssets[0][1]).toBe(`external://local/${hash(shared)}`)
        expect(decoded.characters[0].additionalAssets[1][1]).toBe(`external://local/${hash(plugin)}`)
        expect(decoded.characters[0].additionalAssets[2][1]).toBe('assets/stale.png')
        expect(decoded.chatsAddedWhileStaging).toEqual(['kept'])
        expect(journal.getJob(job.id).status).toBe('published')
        expect(journal.getJob(job.id).staleItems).toBe(1)
        expect(chunks.getValue(result.safetyBackupKey)).toBeTruthy()
    })

    it('does not mutate references, manifest, or originals before staged copies are reverified', async () => {
        db = new Database(':memory:')
        db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)`)
        const chunks = createChunkStore(db, { threshold: 32 })
        const journal = createExternalAssetMigrationJournal({ db, makeId: () => 'unverified-job' })
        const original = Buffer.from('must remain internal')
        const internalKey = 'assets/original.png'
        const originalDb = { characters: [{ chaId: 'c1', image: internalKey }], modules: [], personas: [] }
        chunks.putValue('database/database.bin', Buffer.from(encodeRisuSaveLegacy(originalDb)))
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 1)').run(internalKey, original)
        const job = journal.createJob({ providerId: 'local', items: [{ internalKey, size: original.length }] })
        journal.resumeJob(job.id)
        journal.markItemStaged(job.id, 0, {
            uri: `external://local/${hash(original)}`,
            hash: hash(original),
            size: original.length,
        })
        journal.updateJobStatus(job.id, 'staged')

        await expect(finalizeExternalAssetMigration({ db, jobId: job.id, chunkStore: chunks, journal }))
            .rejects.toThrow(/cannot be finalized from staged/)
        expect(db.prepare('SELECT value FROM kv WHERE key = ?').get(internalKey).value).toEqual(original)
        expect(chunks.getValue('external-assets/manifest.v1.json')).toBeNull()
        expect((await decodeRisuSave(chunks.getValue('database/database.bin'))).characters[0].image).toBe(internalKey)
    })
})
