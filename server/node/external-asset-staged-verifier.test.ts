import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createExternalAssetMigrationJournal } = require('./external-asset-migration-journal.cjs')
const { verifyStagedMigration } = require('./external-asset-staged-verifier.cjs')

describe('detached staged-copy verifier', () => {
    const providerFingerprint = 'provider-fingerprint-test'
    let db: Database.Database

    beforeEach(() => {
        db = new Database(':memory:')
    })

    it('runs sequentially, persists successes, and resumes only failed receipts', async () => {
        const journal = createExternalAssetMigrationJournal({ db, makeId: () => 'verify-job' })
        const job = journal.createJob({
            providerId: 'external',
            items: [
                { internalKey: 'assets/a.png', size: 10 },
                { internalKey: 'assets/b.png', size: 20 },
            ],
        })
        journal.resumeJob(job.id)
        journal.markItemStaged(job.id, 0, {
            uri: `external://external/${'a'.repeat(64)}`,
            hash: 'a'.repeat(64),
            size: 10,
            trashPath: 'verify-job/a',
        })
        journal.markItemStaged(job.id, 1, {
            uri: `external://external/${'b'.repeat(64)}`,
            hash: 'b'.repeat(64),
            size: 20,
            trashPath: 'verify-job/b',
        })
        journal.updateJobStatus(job.id, 'staged')
        journal.beginStagedVerification(job.id, { providerFingerprint })

        let active = 0
        let maxActive = 0
        const attempts: string[] = []
        let failSecond = true
        const service = {
            verifyDetachedReceipt: vi.fn(async (receipt: any) => {
                active++
                maxActive = Math.max(maxActive, active)
                attempts.push(receipt.hash)
                await Promise.resolve()
                active--
                if (receipt.hash === 'b'.repeat(64) && failSecond) throw new Error('provider object corrupt')
                return { ...receipt, verifiedAt: '2026-08-25T00:00:00.000Z' }
            }),
            verifyRecoveryReceipt: vi.fn(async (receipt: any) => ({
                ...receipt,
                verifiedAt: '2026-08-25T00:00:01.000Z',
            })),
        }

        const first = await verifyStagedMigration({
            journal,
            service,
            jobId: job.id,
            batchLimit: 2,
            providerFingerprint,
        })
        expect(first).toMatchObject({
            status: 'verification-failed',
            verifiedStagedItems: 1,
            verifiedStagedBytes: 10,
            verificationFailedItems: 1,
        })
        expect(maxActive).toBe(1)
        expect(attempts).toEqual(['a'.repeat(64), 'b'.repeat(64)])
        expect(() => journal.assertReadyForPublish(job.id)).toThrow(/has not passed/)

        failSecond = false
        attempts.length = 0
        journal.beginStagedVerification(job.id, { providerFingerprint })
        const resumed = await verifyStagedMigration({
            journal,
            service,
            jobId: job.id,
            batchLimit: 2,
            providerFingerprint,
        })
        expect(resumed).toMatchObject({
            status: 'staged-verified',
            verifiedStagedItems: 2,
            verifiedStagedBytes: 30,
            verificationFailedItems: 0,
            verificationProgress: 1,
        })
        expect(attempts).toEqual(['b'.repeat(64)])
        expect(journal.assertReadyForPublish(job.id, { providerFingerprint }).status).toBe('staged-verified')
    })
})
