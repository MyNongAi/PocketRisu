import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import journalModule from './external-asset-migration-journal.cjs'

const { createExternalAssetMigrationJournal } = journalModule
const PROVIDER_FINGERPRINT = 'provider-fingerprint-test'

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
        expect(() => journal.markPublished('job-3')).toThrow(/has not passed pre-publish verification/)
        journal.beginStagedVerification('job-3', { providerFingerprint: PROVIDER_FINGERPRINT })
        journal.markItemPrepublishVerified('job-3', 0, { hash: 'a', size: 1, providerFingerprint: PROVIDER_FINGERPRINT })
        journal.markItemPrepublishVerified('job-3', 1, { hash: 'b', size: 2, providerFingerprint: PROVIDER_FINGERPRINT })
        expect(journal.completeStagedVerification('job-3', { providerFingerprint: PROVIDER_FINGERPRINT })).toMatchObject({
            status: 'staged-verified',
            verifiedStagedItems: 2,
            verifiedStagedBytes: 3,
            verificationProgress: 1,
        })
        expect(() => journal.assertReadyForPublish('job-3', {
            providerFingerprint: 'different-provider-fingerprint',
        })).toThrow(/fingerprint changed/)
        const published = journal.markPublished('job-3', {
            staleOrdinals: [1],
            safetyBackupKey: 'migration-backup/job-3.bin',
            metadata: { rewrittenReferences: 4 },
            providerFingerprint: PROVIDER_FINGERPRINT,
        })
        expect(published).toMatchObject({ status: 'published', publishedItems: 1, staleItems: 1 })
        expect(journal.recoverFinalizeFailure('job-3', new Error('worker IPC disappeared')).status).toBe('published')
        expect(journal.stagedItems('job-3').map((item: any) => item.status)).toEqual(['published', 'stale'])
    })

    it('keeps successful pre-publish receipts when verification is interrupted', () => {
        const journal = createExternalAssetMigrationJournal({ db, makeId: () => 'verify-resume' })
        journal.createJob({
            providerId: 'local',
            items: [
                { internalKey: 'assets/a', size: 4 },
                { internalKey: 'assets/b', size: 5 },
            ],
        })
        journal.resumeJob('verify-resume')
        journal.markItemStaged('verify-resume', 0, { uri: 'external://local/a', hash: 'a', size: 4 })
        journal.markItemStaged('verify-resume', 1, { uri: 'external://local/b', hash: 'b', size: 5 })
        journal.updateJobStatus('verify-resume', 'staged')
        journal.beginStagedVerification('verify-resume', { providerFingerprint: PROVIDER_FINGERPRINT })
        journal.markItemPrepublishVerified('verify-resume', 0, { hash: 'a', size: 4, providerFingerprint: PROVIDER_FINGERPRINT })

        expect(journal.recoverInterrupted()).toBe(1)
        expect(journal.getJob('verify-resume')).toMatchObject({
            status: 'staged',
            verifiedStagedItems: 1,
            verifiedStagedBytes: 4,
        })
        journal.beginStagedVerification('verify-resume', { providerFingerprint: PROVIDER_FINGERPRINT })
        expect(journal.stagedVerificationBatch('verify-resume').map((item: any) => item.ordinal)).toEqual([1])
    })

    it('invalidates unpublished verification receipts when provider configuration changes', () => {
        const journal = createExternalAssetMigrationJournal({ db, makeId: () => 'config-job' })
        journal.createJob({ providerId: 'local', items: [{ internalKey: 'assets/a', size: 4 }] })
        journal.resumeJob('config-job')
        journal.markItemStaged('config-job', 0, { uri: 'external://local/a', hash: 'a', size: 4 })
        journal.updateJobStatus('config-job', 'staged')
        journal.beginStagedVerification('config-job', { providerFingerprint: PROVIDER_FINGERPRINT })
        journal.markItemPrepublishVerified('config-job', 0, { hash: 'a', size: 4, providerFingerprint: PROVIDER_FINGERPRINT })
        expect(journal.completeStagedVerification('config-job', { providerFingerprint: PROVIDER_FINGERPRINT }).status).toBe('staged-verified')

        expect(journal.invalidateStagedVerifications()).toBe(1)
        expect(journal.getJob('config-job')).toMatchObject({
            status: 'staged',
            verifiedStagedItems: 0,
            verifiedStagedBytes: 0,
        })
        journal.beginStagedVerification('config-job', { providerFingerprint: 'provider-fingerprint-new' })
        expect(journal.stagedVerificationBatch('config-job')).toHaveLength(1)
        expect(() => journal.assertReadyForPublish('config-job')).toThrow(/has not passed/)
    })

    it('discards every stale receipt after a full storage replacement', () => {
        let id = 0
        const journal = createExternalAssetMigrationJournal({ db, makeId: () => `job-${++id}` })
        journal.createJob({ providerId: 'local', items: [{ internalKey: 'assets/a', size: 1 }] })
        journal.createJob({ providerId: 'remote', items: [{ internalKey: 'assets/b', size: 2 }] })
        journal.resumeJob('job-1')
        journal.markItemStaged('job-1', 0, { uri: 'external://local/a', hash: 'a', size: 1 })
        journal.updateJobStatus('job-1', 'staged')
        journal.beginStagedVerification('job-1', { providerFingerprint: PROVIDER_FINGERPRINT })
        journal.markItemPrepublishVerified('job-1', 0, { hash: 'a', size: 1, providerFingerprint: PROVIDER_FINGERPRINT })
        journal.completeStagedVerification('job-1', { providerFingerprint: PROVIDER_FINGERPRINT })
        journal.markPublished('job-1', { providerFingerprint: PROVIDER_FINGERPRINT })

        expect(journal.resetForStorageReplacement()).toBe(2)
        expect(journal.listJobs()).toEqual([])
        expect(db.prepare('SELECT COUNT(*) AS count FROM external_asset_migration_items').get()).toEqual({ count: 0 })
    })
})
