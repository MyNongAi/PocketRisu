'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(process.argv[2] || 'save/risuai.db');
const db = new Database(dbPath, { fileMustExist: true });
db.pragma('busy_timeout = 30000');
db.pragma('wal_checkpoint(TRUNCATE)');

const before = {
    fileBytes: fs.statSync(dbPath).size,
    pageSize: db.pragma('page_size', { simple: true }),
    pageCount: db.pragma('page_count', { simple: true }),
    freePages: db.pragma('freelist_count', { simple: true }),
};

db.exec('VACUUM');
db.pragma('wal_checkpoint(TRUNCATE)');
const integrity = db.pragma('integrity_check', { simple: true });
if (integrity !== 'ok') throw new Error(`integrity_check returned ${integrity}`);

const after = {
    fileBytes: fs.statSync(dbPath).size,
    pageSize: db.pragma('page_size', { simple: true }),
    pageCount: db.pragma('page_count', { simple: true }),
    freePages: db.pragma('freelist_count', { simple: true }),
};

process.stdout.write(`${JSON.stringify({ dbPath, before, after, reclaimedBytes: before.fileBytes - after.fileBytes, integrity }, null, 2)}\n`);
db.close();
