'use strict';

/**
 * Verify detached migration receipts without loading the migration as a whole.
 * The journal returns at most a small byte-bounded batch and the loop awaits
 * each provider stat+read+hash check sequentially, releasing that asset before
 * requesting the next one. Successful receipts are durable and skipped when a
 * failed/interrupted job is resumed.
 */
async function verifyStagedMigration(options = {}) {
    const journal = options.journal;
    const service = options.service;
    const jobId = options.jobId;
    if (!journal || typeof journal.stagedVerificationBatch !== 'function') {
        throw new TypeError('migration journal is required');
    }
    if (!service || typeof service.verifyDetachedReceipt !== 'function'
        || typeof service.verifyRecoveryReceipt !== 'function') {
        throw new TypeError('external asset service is required');
    }
    if (typeof jobId !== 'string' || !jobId) throw new TypeError('jobId is required');
    const batchLimit = options.batchLimit ?? 4;
    const maxBatchBytes = options.maxBatchBytes ?? 64 * 1024 * 1024;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const providerFingerprint = options.providerFingerprint;
    if (typeof providerFingerprint !== 'string' || !providerFingerprint) {
        throw new TypeError('providerFingerprint is required');
    }
    const assertContext = typeof options.assertContext === 'function'
        ? options.assertContext
        : async () => {};
    const contextCheckEveryItems = Math.max(1, Math.floor(options.contextCheckEveryItems ?? 256));
    let checkedItems = 0;

    await assertContext(providerFingerprint);
    while (true) {
        let current = journal.getJob(jobId);
        if (!current) throw new Error(`Migration job not found: ${jobId}`);
        if (current.status !== 'verifying') return current;

        const batch = journal.stagedVerificationBatch(jobId, {
            limit: batchLimit,
            maxBytes: maxBatchBytes,
        });
        if (batch.length === 0) {
            await assertContext(providerFingerprint);
            return journal.completeStagedVerification(jobId, { providerFingerprint });
        }

        for (const item of batch) {
            current = journal.getJob(jobId);
            if (!current || current.status !== 'verifying') return current;
            try {
                const result = await service.verifyDetachedReceipt({
                    uri: item.uri,
                    providerId: current.providerId,
                    hash: item.hash,
                    size: item.size,
                });
                // A publish receipt covers both copies that make the migration
                // recoverable: the provider object and the separately managed
                // trash path.  Neither result contains payload bytes.
                const recovery = await service.verifyRecoveryReceipt({
                    trashPath: item.trashPath,
                    hash: item.hash,
                    size: item.size,
                });
                journal.markItemPrepublishVerified(jobId, item.ordinal, {
                    ...result,
                    providerFingerprint,
                    recoveryVerifiedAt: recovery.verifiedAt,
                });
            } catch (error) {
                journal.markItemPrepublishVerificationFailed(jobId, item.ordinal, error);
            }
            current = journal.getJob(jobId);
            onProgress?.({
                jobId,
                status: current?.status,
                verifiedItems: current?.verifiedStagedItems || 0,
                verifiedBytes: current?.verifiedStagedBytes || 0,
                failedItems: current?.verificationFailedItems || 0,
                totalItems: current?.totalItems || 0,
                totalBytes: current?.totalBytes || 0,
            });
            checkedItems += 1;
            if (checkedItems % contextCheckEveryItems === 0) {
                await assertContext(providerFingerprint);
            }
        }
    }
}

module.exports = { verifyStagedMigration };
