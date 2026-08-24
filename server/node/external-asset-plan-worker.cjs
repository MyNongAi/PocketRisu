'use strict';

const nodeCrypto = require('crypto');
const Database = require('better-sqlite3');
const { isMainThread, parentPort, workerData } = require('worker_threads');
const { createChunkStore } = require('./chunkStore.cjs');
const { decodeRisuSave } = require('./utils.cjs');
const {
    collectAssetReferenceSummary,
    isExternalAssetPath,
} = require('./external-asset-references.cjs');
const { createExternalAssetMigrationJournal } = require('./external-asset-migration-journal.cjs');

const DB_BLOB_KEY = 'database/database.bin';

function postProgress(phase, detail = {}) {
    if (parentPort) parentPort.postMessage({ type: 'progress', phase, ...detail });
}

async function buildExternalAssetMigrationPlan(options = {}) {
    const db = options.db;
    if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required');
    const chunkStore = options.chunkStore || createChunkStore(db);
    postProgress('reading-database');
    const raw = chunkStore.getValue(DB_BLOB_KEY);
    if (!raw) throw new Error('database.bin missing');

    postProgress('decoding-database', { databaseBytes: raw.length });
    const decoded = await decodeRisuSave(raw);
    postProgress('collecting-references');
    const internal = collectAssetReferenceSummary(decoded);
    const external = collectAssetReferenceSummary(decoded, isExternalAssetPath);

    // One ordered SQLite scan is substantially cheaper than hundreds of
    // thousands of point queries against the same B-tree.
    postProgress('indexing-assets', { uniqueAssets: internal.uniquePaths.size });
    const sizeRows = db.prepare(`
        SELECT key, LENGTH(value) AS size FROM kv
        WHERE key >= 'assets/' AND key < 'assets0'
    `).all();
    const sizes = new Map(sizeRows.map((row) => [row.key, Number(row.size)]));
    const items = [];
    const missing = [];
    for (const internalKey of internal.uniquePaths) {
        const size = sizes.get(internalKey);
        if (!Number.isSafeInteger(size) || size < 0) missing.push(internalKey);
        else items.push({ internalKey, size });
    }

    return {
        databaseHash: nodeCrypto.createHash('sha256').update(raw).digest('hex'),
        databaseBytes: raw.length,
        references: internal.references,
        alreadyExternal: external.references,
        uniqueAssets: internal.uniquePaths.size,
        items,
        missing,
        bytes: items.reduce((sum, item) => sum + item.size, 0),
    };
}

async function runWorker(input) {
    const dbPath = input && input.dbPath;
    const jobId = input && input.jobId;
    if (typeof dbPath !== 'string' || !dbPath) throw new Error('worker dbPath is required');
    if (typeof jobId !== 'string' || !jobId) throw new Error('worker jobId is required');
    const db = new Database(dbPath, { fileMustExist: true });
    try {
        db.pragma('busy_timeout = 30000');
        db.pragma('journal_mode = WAL');
        const plan = await buildExternalAssetMigrationPlan({ db });
        postProgress('publishing-plan', { items: plan.items.length, bytes: plan.bytes });
        const journal = createExternalAssetMigrationJournal({ db });
        const job = journal.setPlan(jobId, {
            databaseHash: plan.databaseHash,
            startRunning: true,
            items: plan.items,
            metadata: {
                references: plan.references,
                alreadyExternal: plan.alreadyExternal,
                uniqueAssets: plan.uniqueAssets,
                missingCount: plan.missing.length,
                missingSamples: plan.missing.slice(0, 25),
                databaseBytes: plan.databaseBytes,
            },
        });
        return { job, summary: { ...plan, items: undefined, missing: undefined } };
    } finally {
        db.close();
    }
}

if (!isMainThread) {
    runWorker(workerData)
        .then((result) => parentPort.postMessage({ type: 'done', ...result }))
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
    buildExternalAssetMigrationPlan,
    runWorker,
};
