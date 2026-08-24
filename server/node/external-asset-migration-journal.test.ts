import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import journalModule from './external-asset-migration-journal.cjs'

const { createExternalAssetMigrationJournal } = journalModule

describe('external asset migration journal', () => {
    let db: Database.Database
    let clock: number

    beforeEach(() => {
        db = new Database(':memory:')
        clock = 1_000
    })

    it('persists a resumable queue and reports staged progress', () => {
        const journal = createExternalAssetMigrationJournal({
            db,
            now: () => ++clock,
            makeId: () => 'job-1',
        })
        const created = journal.createJob({
            providerId: 'h-drive',
            databaseHash: 'db-hash',
            items: [
                { internalKey: 'assets/a.png', size: 10 },
                { internalKey: 'assets/b.png', size: 20 },
            ],
        })

        expect(created).toMatchObject({ id: 'job-1', totalItems: 2, totalBytes: 30, status: 'queued' })
        expect(journal.pendingBatch('job-1', { limit: 10, maxBytes: 15 }).map((item: any) => item.internalKey))
            .toEqual(['assets/a.png'])

        journal.resumeJob('job-1')
        journal.markItemStaged('job-1', 0, {
            uri: 'external://h-drive/hash-a',
            hash: 'hash-a',
            size: 10,
        })
        expect(journal.getJob('job-1')).toMatchObject({
            status: 'running',
            stagedItems: 1,
            stagedBytes: 10,
            progress: 0.5,
        })
        expect(journal.pendingBatch('job-1').map((item: any) => item.internalKey)).toEqual(['assets/b.png'])
    })

    it('publishes a large plan into a previously visible planning job', () => {
        const journal = createExternalAssetMigrationJournal({ db, makeId: () => 'planning-job' })
        expect(journal.createJob({
            providerId: 'h-drive',
            initialStatus: 'planning',
            items: [],
        })).toMatchObject({ status: 'planning', totalItems: 0 })

        const planned = journal.setPlan('planning-job', {
            databaseHash: 'snapshot-hash',
            startRunning: true,
            items: [
                { internalKey: 'assets/a', size: 4 },
                { internalKey: 'assets/b', size: 5 },
            ],
            metadata: { missing: 3 },
        })
        expect(planned).toMatchObject({
            status: 'running',
            databaseHash: 'snapshot-hash',
            totalItems: 2,
            totalBytes: 9,
            metadata: { missing: 3 },
        })
    })

    it('keeps failures retryable without double-counting staged items', () => {
        const journal = createExternalAssetMigrationJournal({ db, makeId: () => 'job-2' })
        journal.createJob({ providerId: 'local', items: [{ internalKey: 'assets/a', size: 3 }] })
        journal.resumeJob('job-2')
        journal.markItemFailed('job-2', 0, new Error('disk full'))
        expect(journal.getJob('job-2').failedItems).toBe(1)

        journal.updateJobStatus('job-2', 'failed', { error: 'disk full' })
        journal.resumeJob('job-2')
        expect(journal.pendingBatch('job-2')).toHaveLength(1)
        expect(journal.getJob('job-2').failedItems).toBe(0)

        const staged = { uri: 'external://local/hash', hash: 'hash', size: 3 }
        journal.markItemStaged('job-2', 0, staged)
        journal.markItemStaged('job-2', 0, staged)
        expect(journal.getJob('job-2')).toMatchObject({ stagedItems: 1, stagedBytes: 3 })
    })

    it('recovers interrupted jobs as paused and finalizes item states atomically', () => {
        const journal = createExternalAssetMigrationJournal({ db, makeId: () => 'job-3' })
        journal.createJob({
            providerId: 'local',
            items: [
                { internalKey: 'assets/a', size: 1 },
                { internalKey: 'assets/b', size: 2 },
            ],
        })
        journal.resumeJob('job-3')
        journal.markItemStaged('job-3', 0, { uri: 'external://local/a', hash: 'a', size: 1 })
        journal.markItemStaged('job-3', 1, { uri: 'external://local/b', hash: 'b', size: 2 })
        expect(journal.recoverInterrupted()).toBe(1)
        expect(journal.getJob('job-3').status).toBe('paused')

        journal.updateJobStatus('job-3', 'staged')
        const published = journal.markPublished('job-3', {
            staleOrdinals: [1],
            safetyBackupKey: 'migration-backup/job-3.bin',
            metadata: { rewrittenReferences: 4 },
        })
        expect(published).toMatchObject({ status: 'published', publishedItems: 1, staleItems: 1 })
        expect(journal.stagedItems('job-3').map((item: any) => item.status)).toEqual(['published', 'stale'])
    })

    it('discards every stale receipt after a full storage replacement', () => {
        let id = 0
        const journal = createExternalAssetMigrationJournal({ db, makeId: () => `job-${++id}` })
        journal.createJob({ providerId: 'local', items: [{ internalKey: 'assets/a', size: 1 }] })
        journal.createJob({ providerId: 'remote', items: [{ internalKey: 'assets/b', size: 2 }] })
        journal.resumeJob('job-1')
        journal.markItemStaged('job-1', 0, { uri: 'external://local/a', hash: 'a', size: 1 })
        journal.updateJobStatus('job-1', 'staged')
        journal.markPublished('job-1')

        expect(journal.resetForStorageReplacement()).toBe(2)
        expect(journal.listJobs()).toEqual([])
        expect(db.prepare('SELECT COUNT(*) AS count FROM external_asset_migration_items').get()).toEqual({ count: 0 })
    })
})
