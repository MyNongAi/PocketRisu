'use strict';

const nodeCrypto = require('crypto');

const JOB_STATUSES = new Set([
    'planning',
    'queued',
    'running',
    'paused',
    'staged',
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
    const itemColumns = new Set(db.pragma('table_info(external_asset_migration_items)').map((column) => column.name));
    for (const [name, type] of [
        ['trash_path', 'TEXT'],
        ['mime_type', 'TEXT'],
        ['asset_name', 'TEXT'],
        ['staged_at', 'TEXT'],
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
        db.prepare(`
            UPDATE external_asset_migration_items
            SET status = 'staged', uri = ?, hash = ?, trash_path = ?, mime_type = ?,
                asset_name = ?, staged_at = ?, error = NULL, updated_at = ?
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
        const info = db.prepare(`
            UPDATE external_asset_migration_jobs
            SET status = 'paused', error = 'Server stopped before migration completed', updated_at = ?
            WHERE status IN ('running', 'finalizing')
        `).run(timestamp);
        return info.changes;
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
        resumeJob,
        pauseJob,
        cancelJob,
        markPublished,
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
