'use strict';

const nodeCrypto = require('crypto');

const JOB_STATUSES = new Set([
    'planning',
    'queued',
    'running',
    'paused',
    'staged',
    'verifying',
    'verification-failed',
    'staged-verified',
    'finalizing',
    'published',
    'verified',
    'cleaned',
    'canceled',
    'failed',
]);

const TERMINAL_JOB_STATUSES = new Set(['cleaned', 'canceled']);
const RESUMABLE_JOB_STATUSES = new Set(['queued', 'running', 'paused', 'failed']);

function assertText(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${label} must be a non-empty string`);
    }
    return value;
}

function assertNonNegativeInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
    return parsed;
}

function createExternalAssetMigrationJournal(options = {}) {
    const db = options.db;
    if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
        throw new TypeError('A better-sqlite3 compatible db is required');
    }
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const makeId = typeof options.makeId === 'function'
        ? options.makeId
        : () => `${Date.now()}-${nodeCrypto.randomUUID()}`;

    db.exec(`
        CREATE TABLE IF NOT EXISTS external_asset_migration_jobs (
            id TEXT PRIMARY KEY,
            provider_id TEXT NOT NULL,
            database_hash TEXT,
            status TEXT NOT NULL,
            total_items INTEGER NOT NULL,
            total_bytes INTEGER NOT NULL,
            staged_items INTEGER NOT NULL DEFAULT 0,
            staged_bytes INTEGER NOT NULL DEFAULT 0,
            failed_items INTEGER NOT NULL DEFAULT 0,
            verified_staged_items INTEGER NOT NULL DEFAULT 0,
            verified_staged_bytes INTEGER NOT NULL DEFAULT 0,
            verification_failed_items INTEGER NOT NULL DEFAULT 0,
            verification_provider_fingerprint TEXT,
            stale_items INTEGER NOT NULL DEFAULT 0,
            published_items INTEGER NOT NULL DEFAULT 0,
            cleaned_items INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            error TEXT,
            safety_backup_key TEXT,
            metadata_json TEXT
        );
        CREATE TABLE IF NOT EXISTS external_asset_migration_items (
            job_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            internal_key TEXT NOT NULL,
            size INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            uri TEXT,
            hash TEXT,
            trash_path TEXT,
            mime_type TEXT,
            asset_name TEXT,
            staged_at TEXT,
            prepublish_verified_at TEXT,
            prepublish_verified_hash TEXT,
            prepublish_verified_size INTEGER,
            prepublish_provider_fingerprint TEXT,
            prepublish_verification_error TEXT,
            error TEXT,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (job_id, ordinal),
            UNIQUE (job_id, internal_key),
            FOREIGN KEY (job_id) REFERENCES external_asset_migration_jobs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_external_asset_migration_items_status
            ON external_asset_migration_items(job_id, status, ordinal);
        CREATE INDEX IF NOT EXISTS idx_external_asset_migration_jobs_updated
            ON external_asset_migration_jobs(updated_at DESC);
    `);

    // Keep preview/development databases forward-compatible if this feature
    // was initialized before detached staging receipts were introduced.
    const jobColumns = new Set(db.pragma('table_info(external_asset_migration_jobs)').map((column) => column.name));
    for (const [name, type] of [
        ['verified_staged_items', 'INTEGER NOT NULL DEFAULT 0'],
        ['verified_staged_bytes', 'INTEGER NOT NULL DEFAULT 0'],
        ['verification_failed_items', 'INTEGER NOT NULL DEFAULT 0'],
        ['verification_provider_fingerprint', 'TEXT'],
    ]) {
        if (!jobColumns.has(name)) db.exec(`ALTER TABLE external_asset_migration_jobs ADD COLUMN ${name} ${type}`);
    }

    const itemColumns = new Set(db.pragma('table_info(external_asset_migration_items)').map((column) => column.name));
    for (const [name, type] of [
        ['trash_path', 'TEXT'],
        ['mime_type', 'TEXT'],
        ['asset_name', 'TEXT'],
        ['staged_at', 'TEXT'],
        ['prepublish_verified_at', 'TEXT'],
        ['prepublish_verified_hash', 'TEXT'],
        ['prepublish_verified_size', 'INTEGER'],
        ['prepublish_provider_fingerprint', 'TEXT'],
        ['prepublish_verification_error', 'TEXT'],
    ]) {
        if (!itemColumns.has(name)) db.exec(`ALTER TABLE external_asset_migration_items ADD COLUMN ${name} ${type}`);
    }

    const insertJob = db.prepare(`
        INSERT INTO external_asset_migration_jobs (
            id, provider_id, database_hash, status, total_items, total_bytes,
            created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
    `);
    const insertItem = db.prepare(`
        INSERT INTO external_asset_migration_items (
            job_id, ordinal, internal_key, size, status, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?)
    `);
    const selectJob = db.prepare('SELECT * FROM external_asset_migration_jobs WHERE id = ?');
    const selectJobs = db.prepare('SELECT * FROM external_asset_migration_jobs ORDER BY created_at DESC LIMIT ?');
    const selectItems = db.prepare('SELECT * FROM external_asset_migration_items WHERE job_id = ? ORDER BY ordinal');
    const selectPending = db.prepare(`
        SELECT * FROM external_asset_migration_items
        WHERE job_id = ? AND status = 'pending'
        ORDER BY ordinal
        LIMIT ?
    `);
    const selectUnverifiedStaged = db.prepare(`
        SELECT * FROM external_asset_migration_items
        WHERE job_id = ? AND status = 'staged'
          AND prepublish_verification_error IS NULL
          AND (
            prepublish_verified_at IS NULL
            OR prepublish_verified_hash IS NULL
            OR prepublish_verified_hash != hash
            OR prepublish_verified_size IS NULL
            OR prepublish_verified_size != size
            OR prepublish_provider_fingerprint IS NULL
            OR prepublish_provider_fingerprint != ?
          )
        ORDER BY ordinal
        LIMIT ?
    `);
    const selectItem = db.prepare(`
        SELECT * FROM external_asset_migration_items WHERE job_id = ? AND ordinal = ?
    `);
    const selectStaged = db.prepare(`
        SELECT * FROM external_asset_migration_items
        WHERE job_id = ? AND status IN ('staged', 'published', 'stale', 'cleaned')
        ORDER BY ordinal
    `);

    function parseMetadata(value) {
        if (!value) return null;
        try { return JSON.parse(value); }
        catch { return null; }
    }

    function publicJob(row, includeItems = false) {
        if (!row) return null;
        const job = {
            id: row.id,
            providerId: row.provider_id,
            databaseHash: row.database_hash || null,
            status: row.status,
            totalItems: Number(row.total_items),
            totalBytes: Number(row.total_bytes),
            stagedItems: Number(row.staged_items),
            stagedBytes: Number(row.staged_bytes),
            failedItems: Number(row.failed_items),
            verifiedStagedItems: Number(row.verified_staged_items || 0),
            verifiedStagedBytes: Number(row.verified_staged_bytes || 0),
            verificationFailedItems: Number(row.verification_failed_items || 0),
            verificationProviderFingerprint: row.verification_provider_fingerprint || null,
            staleItems: Number(row.stale_items),
            publishedItems: Number(row.published_items),
            cleanedItems: Number(row.cleaned_items),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            error: row.error || null,
            safetyBackupKey: row.safety_backup_key || null,
            metadata: parseMetadata(row.metadata_json),
        };
        job.progress = job.totalItems > 0 ? job.stagedItems / job.totalItems : 1;
        job.verificationProgress = job.totalItems > 0
            ? job.verifiedStagedItems / job.totalItems
            : (job.status === 'staged-verified' ? 1 : 0);
        if (includeItems) job.items = selectItems.all(row.id).map(publicItem);
        return job;
    }

    function publicItem(row) {
        return {
            jobId: row.job_id,
            ordinal: Number(row.ordinal),
            internalKey: row.internal_key,
            size: Number(row.size),
            status: row.status,
            uri: row.uri || null,
            hash: row.hash || null,
            trashPath: row.trash_path || null,
            mimeType: row.mime_type || null,
            assetName: row.asset_name || null,
            stagedAt: row.staged_at || null,
            prepublishVerifiedAt: row.prepublish_verified_at || null,
            prepublishVerifiedHash: row.prepublish_verified_hash || null,
            prepublishVerifiedSize: row.prepublish_verified_size === null || row.prepublish_verified_size === undefined
                ? null
                : Number(row.prepublish_verified_size),
            prepublishProviderFingerprint: row.prepublish_provider_fingerprint || null,
            prepublishVerificationError: row.prepublish_verification_error || null,
            error: row.error || null,
            updatedAt: Number(row.updated_at),
        };
    }

    const createJobTransaction = db.transaction((input) => {
        const id = assertText(input.id || makeId(), 'job id');
        const providerId = assertText(input.providerId, 'provider id');
        const items = Array.isArray(input.items) ? input.items : [];
        const seen = new Set();
        let totalBytes = 0;
        const normalized = items.map((item, ordinal) => {
            const internalKey = assertText(item && item.internalKey, 'internal key');
            if (seen.has(internalKey)) throw new Error(`Duplicate migration key: ${internalKey}`);
            seen.add(internalKey);
            const size = assertNonNegativeInteger(item.size, 'asset size');
            totalBytes += size;
            if (!Number.isSafeInteger(totalBytes)) throw new RangeError('Migration byte total exceeds safe integer range');
            return { ordinal, internalKey, size };
        });
        const timestamp = now();
        const initialStatus = input.initialStatus || 'queued';
        if (initialStatus !== 'planning' && initialStatus !== 'queued') {
            throw new TypeError(`Invalid initial migration status: ${initialStatus}`);
        }
        insertJob.run(
            id,
            providerId,
            typeof input.databaseHash === 'string' ? input.databaseHash : null,
            normalized.length,
            totalBytes,
            timestamp,
            timestamp,
        );
        if (initialStatus !== 'queued') {
            db.prepare('UPDATE external_asset_migration_jobs SET status = ? WHERE id = ?').run(initialStatus, id);
        }
        for (const item of normalized) {
            insertItem.run(id, item.ordinal, item.internalKey, item.size, timestamp);
        }
        return publicJob(selectJob.get(id));
    });

    function createJob(input) {
        return createJobTransaction(input || {});
    }

    const setPlanTransaction = db.transaction((id, input) => {
        const row = selectJob.get(id);
        if (!row) throw new Error(`Migration job not found: ${id}`);
        if (row.status !== 'planning' && row.status !== 'queued' && row.status !== 'failed') {
            throw new Error(`Migration plan cannot replace job in ${row.status}`);
        }
        const items = Array.isArray(input.items) ? input.items : [];
        const seen = new Set();
        let totalBytes = 0;
        const timestamp = now();
        db.prepare('DELETE FROM external_asset_migration_items WHERE job_id = ?').run(id);
        for (let ordinal = 0; ordinal < items.length; ordinal++) {
            const item = items[ordinal];
            const internalKey = assertText(item && item.internalKey, 'internal key');
            if (seen.has(internalKey)) throw new Error(`Duplicate migration key: ${internalKey}`);
            seen.add(internalKey);
            const size = assertNonNegativeInteger(item.size, 'asset size');
            totalBytes += size;
            if (!Number.isSafeInteger(totalBytes)) throw new RangeError('Migration byte total exceeds safe integer range');
            insertItem.run(id, ordinal, internalKey, size, timestamp);
        }
        db.prepare(`
            UPDATE external_asset_migration_jobs
            SET database_hash = ?, status = ?, total_items = ?, total_bytes = ?,
                staged_items = 0, staged_bytes = 0, failed_items = 0,
                verified_staged_items = 0, verified_staged_bytes = 0,
                verification_failed_items = 0,
                verification_provider_fingerprint = NULL,
                stale_items = 0, published_items = 0, cleaned_items = 0,
                error = NULL, metadata_json = ?, updated_at = ?
            WHERE id = ?
        `).run(
            typeof input.databaseHash === 'string' ? input.databaseHash : null,
            input.startRunning === true ? 'running' : 'queued',
            items.length,
            totalBytes,
            input.metadata === undefined ? null : JSON.stringify(input.metadata),
            timestamp,
            id,
        );
        return publicJob(selectJob.get(id));
    });

    function setPlan(id, input = {}) {
        return setPlanTransaction(assertText(id, 'job id'), input);
    }

    function getJob(id, options = {}) {
        return publicJob(selectJob.get(assertText(id, 'job id')), options.includeItems === true);
    }

    function listJobs(limit = 20) {
        const normalizedLimit = Math.min(100, Math.max(1, assertNonNegativeInteger(limit, 'limit')));
        return selectJobs.all(normalizedLimit).map((row) => publicJob(row));
    }

    function updateJobStatus(id, status, options = {}) {
        assertText(id, 'job id');
        if (!JOB_STATUSES.has(status)) throw new TypeError(`Invalid migration status: ${status}`);
        const timestamp = now();
        const info = db.prepare(`
            UPDATE external_asset_migration_jobs
            SET status = ?, updated_at = ?, error = ?,
                safety_backup_key = COALESCE(?, safety_backup_key),
                metadata_json = COALESCE(?, metadata_json)
            WHERE id = ?
        `).run(
            status,
            timestamp,
            options.error ? String(options.error) : null,
            options.safetyBackupKey || null,
            options.metadata === undefined ? null : JSON.stringify(options.metadata),
            id,
        );
        if (info.changes === 0) throw new Error(`Migration job not found: ${id}`);
        return getJob(id);
    }

    function pendingBatch(id, options = {}) {
        const limit = Math.min(1000, Math.max(1, assertNonNegativeInteger(options.limit ?? 32, 'batch limit')));
        const maxBytes = Math.max(1, assertNonNegativeInteger(options.maxBytes ?? 64 * 1024 * 1024, 'batch bytes'));
        const rows = selectPending.all(assertText(id, 'job id'), limit);
        const selected = [];
        let bytes = 0;
        for (const row of rows) {
            const size = Number(row.size);
            if (selected.length > 0 && bytes + size > maxBytes) break;
            selected.push(publicItem(row));
            bytes += size;
            if (bytes >= maxBytes) break;
        }
        return selected;
    }

    const markItemStagedTransaction = db.transaction((id, ordinal, result) => {
        const old = selectItem.get(id, ordinal);
        if (!old) throw new Error(`Migration item not found: ${id}/${ordinal}`);
        const timestamp = now();
        const uri = assertText(result.uri, 'external uri');
        const hash = assertText(result.hash, 'asset hash');
        const size = assertNonNegativeInteger(result.size, 'asset size');
        if (size !== Number(old.size)) throw new Error(`Staged size mismatch for ${old.internal_key}`);
        const wasPrepublishVerified = !!old.prepublish_verified_at
            && old.prepublish_verified_hash === old.hash
            && Number(old.prepublish_verified_size) === Number(old.size);
        const hadVerificationError = !!old.prepublish_verification_error;
        db.prepare(`
            UPDATE external_asset_migration_items
            SET status = 'staged', uri = ?, hash = ?, trash_path = ?, mime_type = ?,
                asset_name = ?, staged_at = ?,
                prepublish_verified_at = NULL, prepublish_verified_hash = NULL,
                prepublish_verified_size = NULL, prepublish_provider_fingerprint = NULL,
                prepublish_verification_error = NULL,
                error = NULL, updated_at = ?
            WHERE job_id = ? AND ordinal = ?
        `).run(
            uri,
            hash,
            typeof result.trashPath === 'string' ? result.trashPath : null,
            typeof result.mimeType === 'string' ? result.mimeType : null,
            typeof result.assetName === 'string' ? result.assetName : null,
            typeof result.stagedAt === 'string' && result.stagedAt ? result.stagedAt : new Date(timestamp).toISOString(),
            timestamp,
            id,
            ordinal,
        );
        if (old.status !== 'staged' && old.status !== 'published' && old.status !== 'cleaned') {
            db.prepare(`
                UPDATE external_asset_migration_jobs
                SET staged_items = staged_items + 1,
                    staged_bytes = staged_bytes + ?,
                    failed_items = CASE WHEN ? = 'failed' THEN MAX(0, failed_items - 1) ELSE failed_items END,
                    updated_at = ?, error = NULL
                WHERE id = ?
            `).run(size, old.status, timestamp, id);
        }
        if (wasPrepublishVerified || hadVerificationError) {
            db.prepare(`
                UPDATE external_asset_migration_jobs
                SET verified_staged_items = MAX(0, verified_staged_items - ?),
                    verified_staged_bytes = MAX(0, verified_staged_bytes - ?),
                    verification_failed_items = MAX(0, verification_failed_items - ?),
                    updated_at = ?
                WHERE id = ?
            `).run(
                wasPrepublishVerified ? 1 : 0,
                wasPrepublishVerified ? Number(old.size) : 0,
                hadVerificationError ? 1 : 0,
                timestamp,
                id,
            );
        }
        return publicItem(selectItem.get(id, ordinal));
    });

    function markItemStaged(id, ordinal, result) {
        return markItemStagedTransaction(
            assertText(id, 'job id'),
            assertNonNegativeInteger(ordinal, 'ordinal'),
            result || {},
        );
    }

    const markItemFailedTransaction = db.transaction((id, ordinal, error) => {
        const old = selectItem.get(id, ordinal);
        if (!old) throw new Error(`Migration item not found: ${id}/${ordinal}`);
        const timestamp = now();
        db.prepare(`
            UPDATE external_asset_migration_items
            SET status = 'failed', error = ?, updated_at = ?
            WHERE job_id = ? AND ordinal = ?
        `).run(String(error && error.message ? error.message : error), timestamp, id, ordinal);
        if (old.status !== 'failed') {
            db.prepare(`
                UPDATE external_asset_migration_jobs
                SET failed_items = failed_items + 1, updated_at = ? WHERE id = ?
            `).run(timestamp, id);
        }
        return publicItem(selectItem.get(id, ordinal));
    });

    function markItemFailed(id, ordinal, error) {
        return markItemFailedTransaction(
            assertText(id, 'job id'),
            assertNonNegativeInteger(ordinal, 'ordinal'),
            error,
        );
    }

    const beginStagedVerificationTransaction = db.transaction((id, restart, providerFingerprint) => {
        const row = selectJob.get(id);
        if (!row) throw new Error(`Migration job not found: ${id}`);
        if (!['staged', 'verifying', 'verification-failed', 'staged-verified'].includes(row.status)) {
            throw new Error(`Staged verification cannot start from ${row.status}`);
        }
        if (Number(row.staged_items) !== Number(row.total_items) || Number(row.failed_items) !== 0) {
            throw new Error('Every migration item must be staged before pre-publish verification');
        }
        const fingerprint = assertText(providerFingerprint, 'provider configuration fingerprint');
        const timestamp = now();
        const fingerprintChanged = row.verification_provider_fingerprint !== fingerprint;
        if (restart || row.status === 'staged-verified' || fingerprintChanged) {
            db.prepare(`
                UPDATE external_asset_migration_items
                SET prepublish_verified_at = NULL, prepublish_verified_hash = NULL,
                    prepublish_verified_size = NULL, prepublish_provider_fingerprint = NULL,
                    prepublish_verification_error = NULL,
                    updated_at = ?
                WHERE job_id = ? AND status = 'staged'
            `).run(timestamp, id);
            db.prepare(`
                UPDATE external_asset_migration_jobs
                SET verified_staged_items = 0, verified_staged_bytes = 0,
                    verification_failed_items = 0
                WHERE id = ?
            `).run(id);
        } else {
            // Successful receipts survive an interruption/failure. Only failed
            // rows are reopened, making a multi-hour 47 GB pass resumable.
            db.prepare(`
                UPDATE external_asset_migration_items
                SET prepublish_verification_error = NULL, updated_at = ?
                WHERE job_id = ? AND status = 'staged'
                  AND prepublish_verification_error IS NOT NULL
            `).run(timestamp, id);
            db.prepare(`
                UPDATE external_asset_migration_jobs
                SET verification_failed_items = 0
                WHERE id = ?
            `).run(id);
        }
        db.prepare(`
            UPDATE external_asset_migration_jobs
            SET status = 'verifying', verification_provider_fingerprint = ?,
                error = NULL, updated_at = ?
            WHERE id = ?
        `).run(fingerprint, timestamp, id);
        return publicJob(selectJob.get(id));
    });

    function beginStagedVerification(id, options = {}) {
        return beginStagedVerificationTransaction(
            assertText(id, 'job id'),
            options.restart === true,
            options.providerFingerprint,
        );
    }

    function stagedVerificationBatch(id, options = {}) {
        const limit = Math.min(64, Math.max(1, assertNonNegativeInteger(options.limit ?? 4, 'verification batch limit')));
        const maxBytes = Math.max(1, assertNonNegativeInteger(options.maxBytes ?? 64 * 1024 * 1024, 'verification batch bytes'));
        const normalizedId = assertText(id, 'job id');
        const job = selectJob.get(normalizedId);
        if (!job) throw new Error(`Migration job not found: ${normalizedId}`);
        const fingerprint = assertText(job.verification_provider_fingerprint, 'provider configuration fingerprint');
        const rows = selectUnverifiedStaged.all(normalizedId, fingerprint, limit);
        const selected = [];
        let bytes = 0;
        for (const row of rows) {
            const size = Number(row.size);
            if (selected.length > 0 && bytes + size > maxBytes) break;
            selected.push(publicItem(row));
            bytes += size;
            if (bytes >= maxBytes) break;
        }
        return selected;
    }

    const markItemPrepublishVerifiedTransaction = db.transaction((id, ordinal, result) => {
        const job = selectJob.get(id);
        if (!job) throw new Error(`Migration job not found: ${id}`);
        if (job.status !== 'verifying') throw new Error(`Migration job cannot accept verification receipts from ${job.status}`);
        const old = selectItem.get(id, ordinal);
        if (!old) throw new Error(`Migration item not found: ${id}/${ordinal}`);
        if (old.status !== 'staged') throw new Error(`Migration item cannot be verified from ${old.status}`);
        const hash = assertText(result.hash, 'verified asset hash');
        const size = assertNonNegativeInteger(result.size, 'verified asset size');
        const fingerprint = assertText(result.providerFingerprint, 'provider configuration fingerprint');
        if (fingerprint !== job.verification_provider_fingerprint) {
            throw new Error('Provider configuration changed while staged copies were being verified');
        }
        if (hash !== old.hash || size !== Number(old.size)) {
            throw new Error(`Verified receipt mismatch for ${old.internal_key}`);
        }
        const wasVerified = !!old.prepublish_verified_at
            && old.prepublish_verified_hash === old.hash
            && Number(old.prepublish_verified_size) === Number(old.size)
            && old.prepublish_provider_fingerprint === fingerprint;
        const hadError = !!old.prepublish_verification_error;
        const timestamp = now();
        const verifiedAt = typeof result.verifiedAt === 'string' && result.verifiedAt
            ? result.verifiedAt
            : new Date(timestamp).toISOString();
        db.prepare(`
            UPDATE external_asset_migration_items
            SET prepublish_verified_at = ?, prepublish_verified_hash = ?,
                prepublish_verified_size = ?, prepublish_provider_fingerprint = ?,
                prepublish_verification_error = NULL,
                updated_at = ?
            WHERE job_id = ? AND ordinal = ?
        `).run(verifiedAt, hash, size, fingerprint, timestamp, id, ordinal);
        db.prepare(`
            UPDATE external_asset_migration_jobs
            SET verified_staged_items = verified_staged_items + ?,
                verified_staged_bytes = verified_staged_bytes + ?,
                verification_failed_items = MAX(0, verification_failed_items - ?),
                updated_at = ?
            WHERE id = ?
        `).run(wasVerified ? 0 : 1, wasVerified ? 0 : size, hadError ? 1 : 0, timestamp, id);
        return publicItem(selectItem.get(id, ordinal));
    });

    function markItemPrepublishVerified(id, ordinal, result) {
        return markItemPrepublishVerifiedTransaction(
            assertText(id, 'job id'),
            assertNonNegativeInteger(ordinal, 'ordinal'),
            result || {},
        );
    }

    const markItemPrepublishVerificationFailedTransaction = db.transaction((id, ordinal, error) => {
        const job = selectJob.get(id);
        if (!job) throw new Error(`Migration job not found: ${id}`);
        if (job.status !== 'verifying') throw new Error(`Migration job cannot accept verification failures from ${job.status}`);
        const old = selectItem.get(id, ordinal);
        if (!old) throw new Error(`Migration item not found: ${id}/${ordinal}`);
        if (old.status !== 'staged') throw new Error(`Migration item cannot be verified from ${old.status}`);
        const wasVerified = !!old.prepublish_verified_at
            && old.prepublish_verified_hash === old.hash
            && Number(old.prepublish_verified_size) === Number(old.size)
            && old.prepublish_provider_fingerprint === job.verification_provider_fingerprint;
        const hadError = !!old.prepublish_verification_error;
        const timestamp = now();
        db.prepare(`
            UPDATE external_asset_migration_items
            SET prepublish_verified_at = NULL, prepublish_verified_hash = NULL,
                prepublish_verified_size = NULL, prepublish_provider_fingerprint = NULL,
                prepublish_verification_error = ?,
                updated_at = ?
            WHERE job_id = ? AND ordinal = ?
        `).run(String(error?.message || error), timestamp, id, ordinal);
        db.prepare(`
            UPDATE external_asset_migration_jobs
            SET verified_staged_items = MAX(0, verified_staged_items - ?),
                verified_staged_bytes = MAX(0, verified_staged_bytes - ?),
                verification_failed_items = verification_failed_items + ?,
                updated_at = ?
            WHERE id = ?
        `).run(
            wasVerified ? 1 : 0,
            wasVerified ? Number(old.size) : 0,
            hadError ? 0 : 1,
            timestamp,
            id,
        );
        return publicItem(selectItem.get(id, ordinal));
    });

    function markItemPrepublishVerificationFailed(id, ordinal, error) {
        return markItemPrepublishVerificationFailedTransaction(
            assertText(id, 'job id'),
            assertNonNegativeInteger(ordinal, 'ordinal'),
            error,
        );
    }

    const verificationSummary = db.prepare(`
        SELECT
            COUNT(*) AS staged_count,
            SUM(CASE WHEN prepublish_verified_at IS NOT NULL
                      AND prepublish_verified_hash = hash
                      AND prepublish_verified_size = size
                      AND prepublish_provider_fingerprint = @fingerprint THEN 1 ELSE 0 END) AS verified_count,
            COALESCE(SUM(CASE WHEN prepublish_verified_at IS NOT NULL
                              AND prepublish_verified_hash = hash
                              AND prepublish_verified_size = size
                              AND prepublish_provider_fingerprint = @fingerprint THEN size ELSE 0 END), 0) AS verified_bytes,
            SUM(CASE WHEN prepublish_verification_error IS NOT NULL THEN 1 ELSE 0 END) AS failed_count
        FROM external_asset_migration_items
        WHERE job_id = @id AND status = 'staged'
    `);

    const completeStagedVerificationTransaction = db.transaction((id, providerFingerprint) => {
        const row = selectJob.get(id);
        if (!row) throw new Error(`Migration job not found: ${id}`);
        if (row.status !== 'verifying') throw new Error(`Staged verification cannot finish from ${row.status}`);
        const fingerprint = assertText(providerFingerprint, 'provider configuration fingerprint');
        if (row.verification_provider_fingerprint !== fingerprint) {
            throw new Error('Provider configuration changed before staged verification completed');
        }
        const summary = verificationSummary.get({ id, fingerprint });
        const stagedCount = Number(summary.staged_count || 0);
        const verifiedCount = Number(summary.verified_count || 0);
        const verifiedBytes = Number(summary.verified_bytes || 0);
        const failedCount = Number(summary.failed_count || 0);
        const complete = stagedCount === Number(row.total_items)
            && verifiedCount === Number(row.total_items)
            && failedCount === 0;
        const status = complete ? 'staged-verified' : 'verification-failed';
        const error = complete
            ? null
            : failedCount > 0
                ? `${failedCount} staged asset(s) failed pre-publish verification. Repair the provider object from the retained internal/trash copy and retry, or cancel and start migration again from the retained originals; no Risu reference or original has been changed.`
                : 'Pre-publish verification did not cover every staged asset';
        db.prepare(`
            UPDATE external_asset_migration_jobs
            SET status = ?, verified_staged_items = ?, verified_staged_bytes = ?,
                verification_failed_items = ?, error = ?, updated_at = ?
            WHERE id = ?
        `).run(status, verifiedCount, verifiedBytes, failedCount, error, now(), id);
        return publicJob(selectJob.get(id));
    });

    function completeStagedVerification(id, options = {}) {
        return completeStagedVerificationTransaction(
            assertText(id, 'job id'),
            options.providerFingerprint,
        );
    }

    function assertReadyForPublish(id, options = {}) {
        const normalizedId = assertText(id, 'job id');
        const row = selectJob.get(normalizedId);
        if (!row) throw new Error(`Migration job not found: ${normalizedId}`);
        if (row.status !== 'staged-verified' && row.status !== 'finalizing') {
            throw new Error(`Migration job has not passed pre-publish verification: ${row.status}`);
        }
        const fingerprint = assertText(options.providerFingerprint, 'current provider configuration fingerprint');
        if (!row.verification_provider_fingerprint || row.verification_provider_fingerprint !== fingerprint) {
            throw new Error('Provider configuration fingerprint changed after staged verification');
        }
        const summary = verificationSummary.get({ id: normalizedId, fingerprint });
        if (Number(summary.staged_count || 0) !== Number(row.total_items)
            || Number(summary.verified_count || 0) !== Number(row.total_items)
            || Number(summary.failed_count || 0) !== 0) {
            throw new Error('Migration pre-publish verification receipts are incomplete or stale');
        }
        return publicJob(row);
    }

    const invalidateStagedVerificationsTransaction = db.transaction((reason) => {
        const rows = db.prepare(`
            SELECT id FROM external_asset_migration_jobs
            WHERE status IN ('staged', 'verifying', 'verification-failed', 'staged-verified')
        `).all();
        if (rows.length === 0) return 0;
        const timestamp = now();
        const clearItems = db.prepare(`
            UPDATE external_asset_migration_items
            SET prepublish_verified_at = NULL, prepublish_verified_hash = NULL,
                prepublish_verified_size = NULL, prepublish_provider_fingerprint = NULL,
                prepublish_verification_error = NULL,
                updated_at = ?
            WHERE job_id = ? AND status = 'staged'
        `);
        const resetJob = db.prepare(`
            UPDATE external_asset_migration_jobs
            SET status = 'staged', verified_staged_items = 0,
                verified_staged_bytes = 0, verification_failed_items = 0,
                verification_provider_fingerprint = NULL,
                error = ?, updated_at = ?
            WHERE id = ?
        `);
        for (const row of rows) {
            clearItems.run(timestamp, row.id);
            resetJob.run(reason, timestamp, row.id);
        }
        return rows.length;
    });

    function invalidateStagedVerifications(reason = 'External asset provider configuration changed; verify staged copies again') {
        return invalidateStagedVerificationsTransaction(String(reason));
    }

    const resumeJobTransaction = db.transaction((id) => {
        const row = selectJob.get(id);
        if (!row) throw new Error(`Migration job not found: ${id}`);
        if (!RESUMABLE_JOB_STATUSES.has(row.status)) {
            throw new Error(`Migration job cannot resume from ${row.status}`);
        }
        const timestamp = now();
        db.prepare(`
            UPDATE external_asset_migration_items
            SET status = 'pending', error = NULL, updated_at = ?
            WHERE job_id = ? AND status = 'failed'
        `).run(timestamp, id);
        db.prepare(`
            UPDATE external_asset_migration_jobs
            SET status = 'running', failed_items = 0, error = NULL, updated_at = ?
            WHERE id = ?
        `).run(timestamp, id);
        return publicJob(selectJob.get(id));
    });

    function resumeJob(id) {
        return resumeJobTransaction(assertText(id, 'job id'));
    }

    function pauseJob(id) {
        const current = getJob(id);
        if (!current) throw new Error(`Migration job not found: ${id}`);
        if (current.status !== 'running' && current.status !== 'queued') return current;
        return updateJobStatus(id, 'paused');
    }

    function cancelJob(id) {
        const current = getJob(id);
        if (!current) throw new Error(`Migration job not found: ${id}`);
        if (current.status === 'published' || current.status === 'verified' || current.status === 'cleaned') {
            throw new Error(`Published migration job cannot be canceled: ${id}`);
        }
        return updateJobStatus(id, 'canceled');
    }

    const markPublishedTransaction = db.transaction((id, options) => {
        assertReadyForPublish(id, { providerFingerprint: options.providerFingerprint });
        const timestamp = now();
        const staleOrdinals = new Set(options.staleOrdinals || []);
        const rows = selectStaged.all(id);
        let publishedItems = 0;
        let staleItems = 0;
        const update = db.prepare(`
            UPDATE external_asset_migration_items SET status = ?, error = ?, updated_at = ?
            WHERE job_id = ? AND ordinal = ?
        `);
        for (const row of rows) {
            const stale = staleOrdinals.has(Number(row.ordinal));
            update.run(stale ? 'stale' : 'published', stale ? 'Source changed before publish' : null, timestamp, id, row.ordinal);
            if (stale) staleItems++;
            else publishedItems++;
        }
        db.prepare(`
            UPDATE external_asset_migration_jobs
            SET status = 'published', stale_items = ?, published_items = ?,
                safety_backup_key = ?, metadata_json = ?, error = NULL, updated_at = ?
            WHERE id = ?
        `).run(
            staleItems,
            publishedItems,
            options.safetyBackupKey || null,
            JSON.stringify(options.metadata || {}),
            timestamp,
            id,
        );
        return publicJob(selectJob.get(id));
    });

    function markPublished(id, options = {}) {
        return markPublishedTransaction(assertText(id, 'job id'), options);
    }

    const recoverFinalizeFailureTransaction = db.transaction((id, error) => {
        const row = selectJob.get(id);
        if (!row) throw new Error(`Migration job not found: ${id}`);
        // The publish transaction commits the DB rewrite, manifest, deletions,
        // and this status atomically. A later worker/message failure must never
        // downgrade that committed state and accidentally make it publishable
        // a second time.
        if (['published', 'verified', 'cleaned'].includes(row.status)) return publicJob(row);
        if (row.status !== 'finalizing') return publicJob(row);
        const timestamp = now();
        db.prepare(`
            UPDATE external_asset_migration_jobs
            SET status = 'staged-verified', error = ?, updated_at = ?
            WHERE id = ? AND status = 'finalizing'
        `).run(String(error?.message || error || 'External asset finalization failed'), timestamp, id);
        return publicJob(selectJob.get(id));
    });

    function recoverFinalizeFailure(id, error) {
        return recoverFinalizeFailureTransaction(assertText(id, 'job id'), error);
    }

    function markCleaned(id, cleanedOrdinals = []) {
        assertText(id, 'job id');
        const timestamp = now();
        const ordinals = [...new Set(cleanedOrdinals.map((value) => assertNonNegativeInteger(value, 'ordinal')))];
        const transaction = db.transaction(() => {
            const update = db.prepare(`
                UPDATE external_asset_migration_items
                SET status = 'cleaned', updated_at = ?
                WHERE job_id = ? AND ordinal = ? AND status = 'published'
            `);
            let cleaned = 0;
            for (const ordinal of ordinals) cleaned += update.run(timestamp, id, ordinal).changes;
            db.prepare(`
                UPDATE external_asset_migration_jobs
                SET status = 'cleaned', cleaned_items = cleaned_items + ?, updated_at = ?
                WHERE id = ?
            `).run(cleaned, timestamp, id);
            return publicJob(selectJob.get(id));
        });
        return transaction();
    }

    function stagedItems(id) {
        return selectStaged.all(assertText(id, 'job id')).map(publicItem);
    }

    function recoverInterrupted() {
        const timestamp = now();
        const staging = db.prepare(`
            UPDATE external_asset_migration_jobs
            SET status = 'paused', error = 'Server stopped before migration completed', updated_at = ?
            WHERE status = 'running'
        `).run(timestamp);
        const verifying = db.prepare(`
            UPDATE external_asset_migration_jobs
            SET status = 'staged', error = 'Server stopped during staged-copy verification; verified receipts were preserved', updated_at = ?
            WHERE status = 'verifying'
        `).run(timestamp);
        const finalizing = db.prepare(`
            UPDATE external_asset_migration_jobs
            SET status = 'staged-verified', error = 'Server stopped before publish completed; verify receipts were preserved', updated_at = ?
            WHERE status = 'finalizing'
        `).run(timestamp);
        return staging.changes + verifying.changes + finalizing.changes;
    }

    function deleteTerminalJob(id) {
        const current = getJob(id);
        if (!current) return false;
        if (!TERMINAL_JOB_STATUSES.has(current.status)) {
            throw new Error(`Only terminal migration jobs can be deleted: ${current.status}`);
        }
        return db.prepare('DELETE FROM external_asset_migration_jobs WHERE id = ?').run(id).changes > 0;
    }

    /**
     * Migration jobs describe a specific generation of the Risu database and
     * its internal asset rows. A full backup/save-folder replacement swaps
     * that generation wholesale, so retaining even paused or already
     * published jobs would make their receipts point at unrelated data.
     *
     * The journal is operational metadata rather than user backup content.
     * Clear both tables explicitly instead of relying on foreign-key pragma
     * state, and return the number of discarded jobs for logging/tests.
     */
    const resetForStorageReplacementTransaction = db.transaction(() => {
        const jobs = Number(db.prepare('SELECT COUNT(*) AS count FROM external_asset_migration_jobs').get()?.count || 0);
        db.prepare('DELETE FROM external_asset_migration_items').run();
        db.prepare('DELETE FROM external_asset_migration_jobs').run();
        return jobs;
    });

    function resetForStorageReplacement() {
        return resetForStorageReplacementTransaction();
    }

    return {
        createJob,
        setPlan,
        getJob,
        listJobs,
        updateJobStatus,
        pendingBatch,
        markItemStaged,
        markItemFailed,
        beginStagedVerification,
        stagedVerificationBatch,
        markItemPrepublishVerified,
        markItemPrepublishVerificationFailed,
        completeStagedVerification,
        assertReadyForPublish,
        invalidateStagedVerifications,
        resumeJob,
        pauseJob,
        cancelJob,
        markPublished,
        recoverFinalizeFailure,
        markCleaned,
        stagedItems,
        recoverInterrupted,
        deleteTerminalJob,
        resetForStorageReplacement,
    };
}

module.exports = {
    JOB_STATUSES,
    createExternalAssetMigrationJournal,
};
