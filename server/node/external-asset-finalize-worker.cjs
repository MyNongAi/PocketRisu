'use strict';

const path = require('path');
const nodeCrypto = require('crypto');
const fs = require('fs/promises');
const Database = require('better-sqlite3');
const { isMainThread, parentPort, workerData } = require('worker_threads');
const { createChunkStore } = require('./chunkStore.cjs');
const { decodeRisuSave, encodeRisuSaveLegacy } = require('./utils.cjs');
const {
    collectEmbeddedInternalAssetNames,
    rewriteAssetReferencesInPlace,
} = require('./external-asset-references.cjs');
const { createExternalAssetMigrationJournal } = require('./external-asset-migration-journal.cjs');
const { resolveInside } = require('./external-assets.cjs');

const DB_BLOB_KEY = 'database/database.bin';
const EXTERNAL_ASSET_MANIFEST_KEY = 'external-assets/manifest.v1.json';

function postProgress(phase, detail = {}) {
    if (parentPort) parentPort.postMessage({ type: 'progress', phase, ...detail });
}

function collectPluginStorageAssetNames(db) {
    const names = new Set();
    const rows = db.prepare(`
        SELECT value FROM kv
        WHERE key >= 'cache/plugin-storage/' AND key < 'cache/plugin-storage0'
    `).all();
    for (const row of rows) {
        const text = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value ?? '');
        for (const name of collectEmbeddedInternalAssetNames(text)) names.add(name);
    }
    return names;
}

function buildPublishedManifest(existingRaw, job, stagedItems, staleOrdinals) {
    const now = new Date().toISOString();
    let manifest = { version: 1, createdAt: now, updatedAt: now, assets: {} };
    if (existingRaw) {
        manifest = JSON.parse(Buffer.from(existingRaw).toString('utf8'));
        if (manifest?.version !== 1 || !manifest.assets || typeof manifest.assets !== 'object' || Array.isArray(manifest.assets)) {
            throw new Error('Existing external asset manifest is invalid');
        }
    }
    const staleSet = new Set(staleOrdinals);
    for (const item of stagedItems) {
        if (staleSet.has(item.ordinal)) continue;
        const old = manifest.assets[item.uri] && typeof manifest.assets[item.uri] === 'object'
            ? manifest.assets[item.uri]
            : {};
        const fallbacks = Array.isArray(old.fallbacks) ? old.fallbacks.slice() : [];
        const fallback = {
            internalKey: item.internalKey,
            trashPath: item.trashPath,
            stagedAt: item.stagedAt || now,
        };
        const oldFallbackIndex = fallbacks.findIndex((value) => value?.internalKey === item.internalKey);
        if (oldFallbackIndex >= 0) fallbacks[oldFallbackIndex] = fallback;
        else fallbacks.push(fallback);
        const migrationIds = [...new Set([
            ...(Array.isArray(old.migrationIds) ? old.migrationIds : []),
            ...(typeof old.migrationId === 'string' ? [old.migrationId] : []),
            job.id,
        ])];
        manifest.assets[item.uri] = {
            ...old,
            uri: item.uri,
            providerId: job.providerId,
            hash: item.hash,
            size: item.size,
            mimeType: item.mimeType || old.mimeType || 'application/octet-stream',
            assetName: item.assetName || old.assetName || null,
            status: 'staged',
            createdAt: old.createdAt || item.stagedAt || now,
            stagedAt: item.stagedAt || now,
            lastVerifiedAt: item.prepublishVerifiedAt || item.stagedAt || now,
            fallbacks,
            migrationIds,
        };
    }
    manifest.updatedAt = now;
    return Buffer.from(JSON.stringify(manifest), 'utf8');
}

async function assertRecoveryTrashReady(stagedItems, trashDir) {
    if (typeof trashDir !== 'string' || !trashDir) {
        throw new Error('Recovery trash directory is required before publish');
    }
    for (let index = 0; index < stagedItems.length; index++) {
        const item = stagedItems[index];
        if (!item.prepublishVerifiedAt || !item.prepublishProviderFingerprint) {
            throw new Error(`Recovery receipt is missing for staged item ${item.ordinal}`);
        }
        const file = resolveInside(trashDir, item.trashPath);
        const info = await fs.stat(file);
        if (!info.isFile() || info.size !== Number(item.size)) {
            throw new Error(`Recovery trash copy changed after verification: ${item.internalKey}`);
        }
        if (index > 0 && index % 10000 === 0) {
            postProgress('checking-recovery-trash', { current: index, total: stagedItems.length });
        }
    }
}

async function finalizeExternalAssetMigration(options = {}) {
    const db = options.db;
    const jobId = options.jobId;
    const providerFingerprint = options.providerFingerprint;
    const trashDir = options.trashDir;
    if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required');
    if (typeof jobId !== 'string' || !jobId) throw new TypeError('jobId is required');

    const chunkStore = options.chunkStore || createChunkStore(db);
    const journal = options.journal || createExternalAssetMigrationJournal({ db });
    const job = journal.getJob(jobId);
    if (!job) throw new Error(`Migration job not found: ${jobId}`);
    if (job.status !== 'staged-verified' && job.status !== 'finalizing') {
        throw new Error(`Migration job cannot be finalized from ${job.status}`);
    }
    // The provider verification runs outside this worker and records a durable
    // receipt per staged item. Refuse to touch DB references, the manifest, or
    // internal originals unless every current receipt matches its staged hash
    // and size.
    journal.assertReadyForPublish(jobId, { providerFingerprint });
    const stagedItems = journal.stagedItems(jobId).filter((item) => item.status === 'staged');
    if (stagedItems.length === 0) throw new Error('Migration job has no staged assets');

    // The full staged-verification pass hashed both the external object and
    // trash copy. Immediately before deletion, cheaply re-stat every recovery
    // file so a missing/replaced copy cannot leave the provider as the sole
    // surviving original.
    postProgress('checking-recovery-trash', { current: 0, total: stagedItems.length });
    await assertRecoveryTrashReady(stagedItems, trashDir);

    postProgress('reading-current-database');
    const raw = chunkStore.getValue(DB_BLOB_KEY);
    if (!raw) throw new Error('database.bin missing');
    const currentDatabaseHash = nodeCrypto.createHash('sha256').update(raw).digest('hex');

    postProgress('decoding-current-database', { databaseBytes: raw.length });
    const decoded = await decodeRisuSave(raw);
    const replacements = new Map();
    const staleOrdinals = [];
    const missingSourceOrdinals = [];
    const getAsset = db.prepare('SELECT value FROM kv WHERE key = ?');

    postProgress('validating-staged-sources', { total: stagedItems.length });
    for (let index = 0; index < stagedItems.length; index++) {
        const item = stagedItems[index];
        const row = getAsset.get(item.internalKey);
        if (!row) {
            // The external object and trash copy were already verified while
            // staging. A missing original is therefore safe to repair by
            // publishing its external URI, but there is nothing left to drop.
            replacements.set(item.internalKey, item.uri);
            missingSourceOrdinals.push(item.ordinal);
        } else {
            const value = Buffer.from(row.value);
            const hash = nodeCrypto.createHash('sha256').update(value).digest('hex');
            if (value.length !== item.size || hash !== item.hash) staleOrdinals.push(item.ordinal);
            else replacements.set(item.internalKey, item.uri);
        }
        if (index > 0 && index % 10000 === 0) postProgress('validating-staged-sources', { current: index, total: stagedItems.length });
    }

    postProgress('rewriting-references');
    const rewrite = rewriteAssetReferencesInPlace(decoded, replacements);
    if (rewrite.changes === 0) throw new Error('No current character or module references matched the staged assets');

    // Anything still mentioned anywhere in the rewritten DB or plugin KV is
    // conservatively retained. This protects shared icons, user backgrounds,
    // plugin JSON, and HTML/CSS references that are outside the migrated fields.
    postProgress('checking-shared-references');
    const retainedNames = collectEmbeddedInternalAssetNames(decoded);
    for (const name of collectPluginStorageAssetNames(db)) retainedNames.add(name);
    const staleSet = new Set(staleOrdinals);
    const missingSet = new Set(missingSourceOrdinals);
    const removableItems = stagedItems.filter((item) => (
        !staleSet.has(item.ordinal)
        && !missingSet.has(item.ordinal)
        && !retainedNames.has(path.basename(item.internalKey))
    ));

    postProgress('encoding-current-database');
    const encoded = Buffer.from(encodeRisuSaveLegacy(decoded));
    const safetyBackupKey = `migration-backup/pre-external-assets-${Date.now()}.bin`;
    const metadata = {
        ...(job.metadata || {}),
        referencesRewritten: rewrite.changes,
        sourceDatabaseHash: job.databaseHash,
        publishedDatabaseHash: nodeCrypto.createHash('sha256').update(encoded).digest('hex'),
        currentDatabaseHashBeforePublish: currentDatabaseHash,
        retainedInternalAssets: stagedItems.length - removableItems.length,
        missingSourceItems: missingSourceOrdinals.length,
    };

    postProgress('building-manifest');
    const existingManifest = chunkStore.getValue(EXTERNAL_ASSET_MANIFEST_KEY);
    const manifestBuffer = buildPublishedManifest(existingManifest, job, stagedItems, staleOrdinals);

    postProgress('publishing', { removableItems: removableItems.length });
    db.transaction(() => {
        chunkStore.snapshotValue(DB_BLOB_KEY, safetyBackupKey);
        chunkStore.putValue(DB_BLOB_KEY, encoded);
        db.prepare(`
            INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)
        `).run(EXTERNAL_ASSET_MANIFEST_KEY, manifestBuffer, Date.now());
        const deleteAsset = db.prepare('DELETE FROM kv WHERE key = ?');
        for (const item of removableItems) deleteAsset.run(item.internalKey);
        journal.markPublished(jobId, {
            staleOrdinals,
            safetyBackupKey,
            metadata,
            providerFingerprint,
        });
    })();

    return {
        job: journal.getJob(jobId),
        encodedBytes: encoded.length,
        manifestBytes: manifestBuffer.length,
        referencesRewritten: rewrite.changes,
        removedInternalAssets: removableItems.length,
        retainedInternalAssets: stagedItems.length - removableItems.length,
        missingSourceItems: missingSourceOrdinals.length,
        staleItems: staleOrdinals.length,
        safetyBackupKey,
    };
}

async function runWorker(input) {
    const dbPath = input && input.dbPath;
    const jobId = input && input.jobId;
    if (typeof dbPath !== 'string' || !dbPath) throw new Error('worker dbPath is required');
    const db = new Database(dbPath, { fileMustExist: true });
    try {
        db.pragma('busy_timeout = 30000');
        db.pragma('journal_mode = WAL');
        return await finalizeExternalAssetMigration({
            db,
            jobId,
            providerFingerprint: input.providerFingerprint,
            trashDir: input.trashDir,
        });
    } finally {
        db.close();
    }
}

if (!isMainThread) {
    runWorker(workerData)
        .then((result) => parentPort.postMessage({ type: 'done', result }))
        .catch((error) => {
            parentPort.postMessage({
                type: 'error',
                error: error && error.message ? error.message : String(error),
                stack: error && error.stack,
            });
            process.exitCode = 1;
        });
}

module.exports = {
    buildPublishedManifest,
    assertRecoveryTrashReady,
    collectPluginStorageAssetNames,
    finalizeExternalAssetMigration,
    runWorker,
};
