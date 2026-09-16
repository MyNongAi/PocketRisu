'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(process.argv[2] || 'save/risuai.db');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function tableNames() {
    return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all());
}

function count(table) {
    return db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
}

const tables = tableNames();
const output = {
    dbPath,
    bytes: require('fs').statSync(dbPath).size,
    tables: [...tables].sort(),
};

for (const table of [
    'external_asset_manifest_entries',
    'external_asset_manifest_fallbacks',
    'external_asset_manifest_migrations',
    'external_asset_migration_items',
    'external_asset_migration_jobs',
]) {
    if (!tables.has(table)) continue;
    output[table] = {
        count: count(table),
        columns: db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name),
    };
}

if (tables.has('external_asset_manifest_entries')) {
    const columns = new Set(output.external_asset_manifest_entries.columns);
    const statusColumn = columns.has('status') ? 'status' : null;
    if (statusColumn) {
        output.external_asset_manifest_entries.statuses = db.prepare(
            `SELECT ${statusColumn} AS status, COUNT(*) AS count FROM external_asset_manifest_entries GROUP BY ${statusColumn}`,
        ).all();
    }
}

if (tables.has('external_asset_migration_jobs')) {
    const columns = new Set(output.external_asset_migration_jobs.columns);
    const selected = ['id', 'status', 'provider_id', 'created_at', 'updated_at']
        .filter((column) => columns.has(column));
    if (selected.length > 0) {
        output.external_asset_migration_jobs.recent = db.prepare(
            `SELECT ${selected.join(', ')} FROM external_asset_migration_jobs ORDER BY rowid DESC LIMIT 10`,
        ).all();
    }
}

if (tables.has('external_asset_migration_items')) {
    output.external_asset_migration_items.statuses = db.prepare(
        'SELECT status, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM external_asset_migration_items GROUP BY status',
    ).all();
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
db.close();
