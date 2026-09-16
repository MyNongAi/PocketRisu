'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createChunkStore } = require('../server/node/chunkStore.cjs');

const dbPath = path.resolve(process.argv[2] || 'save/risuai.db');
const apply = process.argv.includes('--apply');
const vacuum = process.argv.includes('--vacuum');
const db = new Database(dbPath, { fileMustExist: true });
db.pragma('busy_timeout = 30000');
db.pragma('journal_mode = WAL');

function fail(message) {
    throw new Error(`Refusing snapshot retirement: ${message}`);
}

const jobs = db.prepare(`
    SELECT * FROM external_asset_migration_jobs
    WHERE safety_backup_key IS NOT NULL
    ORDER BY updated_at DESC
`).all();
if (jobs.length !== 1) fail(`expected exactly one migration safety snapshot, found ${jobs.length}`);
const job = jobs[0];
if (!['published', 'verified', 'cleaned'].includes(job.status)) fail(`job is ${job.status}`);
if (Number(job.published_items) !== Number(job.total_items)) fail('not every migration item was published');
if (Number(job.failed_items) !== 0 || Number(job.stale_items) !== 0) fail('migration contains failed or stale items');
if (Number(job.verified_staged_items) !== Number(job.total_items)) fail('pre-publish verification was incomplete');
if (Number(job.verification_failed_items) !== 0) fail('pre-publish verification recorded failures');

const receipt = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
           SUM(CASE WHEN prepublish_verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified,
           SUM(CASE WHEN trash_path IS NOT NULL THEN 1 ELSE 0 END) AS trash
    FROM external_asset_migration_items WHERE job_id = ?
`).get(job.id);
for (const key of ['published', 'verified', 'trash']) {
    if (Number(receipt[key]) !== Number(receipt.total)) fail(`${key} receipts are incomplete`);
}

const configPath = path.join(path.dirname(dbPath), 'external-assets', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const provider = config.providers?.[job.provider_id];
if (!config.enabled || provider?.type !== 'filesystem') fail('published filesystem provider is not enabled');
if (!fs.existsSync(provider.root)) fail(`external store is unavailable: ${provider.root}`);
if (!fs.existsSync(config.trashRoot)) fail(`recovery trash is unavailable: ${config.trashRoot}`);

const chunkStore = createChunkStore(db);
const snapshotKey = job.safety_backup_key;
const snapshotBytes = chunkStore.sizeValue(snapshotKey);
if (!snapshotBytes || !chunkStore.isChunkedKey(snapshotKey)) fail(`snapshot is missing or not chunked: ${snapshotKey}`);
const before = {
    fileBytes: fs.statSync(dbPath).size,
    snapshotBytes,
    reclaimableBytes: chunkStore.reclaimableBytes(),
    chunkCount: db.prepare('SELECT COUNT(*) FROM chunks').pluck().get(),
};

if (!apply) {
    process.stdout.write(`${JSON.stringify({ apply: false, job: job.id, snapshotKey, receipt, before }, null, 2)}\n`);
    db.close();
    process.exit(0);
}

chunkStore.dropValue(snapshotKey);
const removedChunks = chunkStore.gc();
db.pragma('wal_checkpoint(TRUNCATE)');
const afterGc = {
    reclaimableBytes: chunkStore.reclaimableBytes(),
    chunkCount: db.prepare('SELECT COUNT(*) FROM chunks').pluck().get(),
};
if (afterGc.reclaimableBytes !== 0) fail(`chunk GC left ${afterGc.reclaimableBytes} reclaimable bytes`);

if (vacuum) {
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
}
const integrity = db.pragma('integrity_check', { simple: true });
if (integrity !== 'ok') fail(`integrity_check returned ${integrity}`);
const output = {
    apply: true,
    vacuum,
    job: job.id,
    snapshotKey,
    receipt,
    before,
    removedChunks,
    afterGc,
    fileBytes: fs.statSync(dbPath).size,
    integrity,
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
db.close();
