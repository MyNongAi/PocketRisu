'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Packr, Unpackr } = require('msgpackr');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { HEADER, mapFields } = require('./audit-exact-module-duplicates.cjs');
const { replaceFields, prepareRemoval, prepareRestore, externalReferenceAudit } = require('./quarantine-exact-module-duplicates.cjs');
const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false, int64AsType: 'number' });
const encode = value => Buffer.from(packr.encode(value));
const decode = bytes => unpackr.decode(bytes);
const input = value => Buffer.concat([HEADER, encode(value)]);
const object = raw => decode(raw.subarray(HEADER.length));
const moduleOf = (id, fields = {}) => ({ id, name: 'Same', assets: [['x', 'external://disk/hash', 'png']], lorebook: [{ content: 'exact' }], ...fields });
const database = () => ({ modules: [moduleOf('module-0001', { folderId: 'folder-1' }), moduleOf('module-0002', { folderId: 'folder-2' })],
    moduleFolders: [{ id: 'folder-1', name: 'First', moduleIds: ['module-0001'] }, { id: 'folder-2', name: 'Second', moduleIds: ['module-0002'] }],
    moduleActivationHistory: ['module-0001', 'module-0002'], enabledModules: [],
    characters: [{ chaId: 'character', modules: [], chats: [{ message: [{ text: 'unrelated' }] }] }], opaque: Buffer.from([1, 2, 3]) });

test('remove only the exact unreferenced record, keep folder and assets, preserve all unrelated bytes', () => {
    const raw = input(database());
    const result = prepareRemoval(raw, decode, encode);
    const after = object(result.next);
    assert.equal(result.archive.removed.length, 1);
    assert.equal(result.archive.removed[0].module.id, 'module-0002');
    assert.deepEqual(after.modules.map(module => module.id), ['module-0001']);
    assert.deepEqual(after.modules[0].assets, database().modules[0].assets);
    assert.equal(after.moduleFolders.length, 2);
    assert.deepEqual(after.moduleFolders[1].moduleIds, []);
    assert.deepEqual(after.moduleActivationHistory, ['module-0001']);
    const beforeSpans = mapFields(raw, HEADER.length, decode).fields;
    const afterSpans = mapFields(result.next, HEADER.length, decode).fields;
    for (const key of ['characters', 'enabledModules', 'opaque']) {
        const a = beforeSpans.get(key), b = afterSpans.get(key);
        assert.deepEqual(raw.subarray(a.start, a.end), result.next.subarray(b.start, b.end));
    }
});

test('prefer copy with fewer known missing assets without excluding any actual asset path', () => {
    const db = database();
    db.modules[0].sourceInfo = { missingAssetCount: 3 };
    db.modules[1].sourceInfo = { missingAssetCount: 0 };
    const result = prepareRemoval(input(db), decode, encode);
    assert.equal(result.archive.removed[0].module.id, 'module-0001');
    assert.deepEqual(object(result.next).modules.map(module => module.id), ['module-0002']);
});

test('any runtime or external reference blocks the whole pair, including double activation', () => {
    const db = database();
    db.enabledModules = ['module-0001', 'module-0002'];
    const result = prepareRemoval(input(db), decode, encode);
    assert.equal(result.archive.removed.length, 0);
    assert.equal(result.blocked.length, 1);
    const external = prepareRemoval(input(database()), decode, encode, { externalReferences: new Map([['module-0002', 1]]) });
    assert.equal(external.archive.removed.length, 0);
});

test('restore merges only removed modules and their membership; later edits and imports survive', () => {
    const removed = prepareRemoval(input(database()), decode, encode);
    const later = object(removed.next);
    later.modules[0].description = 'user edited keeper later';
    later.modules.push(moduleOf('module-newer', { name: 'Newer' }));
    later.moduleActivationHistory.push('module-newer');
    later.moduleFolders[1].name = 'Renamed after removal';
    later.characters[0].chats[0].message.push({ text: 'later chat' });
    const restore = prepareRestore(input(later), removed.archive, decode, encode);
    const restored = object(restore.next);
    assert.equal(restore.restored, 1);
    assert.equal(restored.modules.length, 3);
    assert.equal(restored.modules[0].description, 'user edited keeper later');
    assert.equal(restored.modules[1].id, 'module-newer');
    assert.equal(restored.modules[2].id, 'module-0002');
    assert.equal(restored.moduleFolders[1].name, 'Renamed after removal');
    assert.deepEqual(restored.moduleFolders[1].moduleIds, ['module-0002']);
    assert.deepEqual(restored.moduleActivationHistory, ['module-0002', 'module-0001', 'module-newer']);
    assert.equal(restored.characters[0].chats[0].message.length, 2);
});

test('restore is idempotent and refuses reused module IDs instead of overwriting later work', () => {
    const removed = prepareRemoval(input(database()), decode, encode);
    const restored = prepareRestore(removed.next, removed.archive, decode, encode);
    assert.equal(prepareRestore(restored.next, removed.archive, decode, encode).restored, 0);
    const current = object(removed.next);
    current.modules.push(moduleOf('module-0002', { description: 'unrelated replacement' }));
    assert.throws(() => prepareRestore(input(current), removed.archive, decode, encode), /identity is already used/);
});

test('restore recreates missing archived folder without overwriting surviving folders', () => {
    const removed = prepareRemoval(input(database()), decode, encode);
    const current = object(removed.next);
    current.moduleFolders = current.moduleFolders.filter(folder => folder.id !== 'folder-2');
    const restored = object(prepareRestore(input(current), removed.archive, decode, encode).next);
    assert.equal(restored.moduleFolders.length, 2);
    assert.equal(restored.moduleFolders[1].id, 'folder-2');
    assert.deepEqual(restored.moduleFolders[1].moduleIds, ['module-0002']);
});

test('bounded writer refuses adding root fields and leaves unknown binary fields intact', () => {
    const raw = input({ modules: [], bytes: Buffer.from([7, 8]) });
    assert.throws(() => replaceFields(raw, { newField: [] }, decode, encode), /Cannot add/);
    assert.deepEqual(object(replaceFields(raw, { modules: [moduleOf('module-0001')] }, decode, encode)).bytes, Buffer.from([7, 8]));
});

test('external reference scan excludes asset/cache/backup bytes but checks plugin/draft records', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE kv(key TEXT,value BLOB); CREATE TABLE chunks(hash TEXT,data BLOB); CREATE TABLE manifest_chunks(manifest_key TEXT,seq INTEGER,hash TEXT)');
    const put = sqlite.prepare('INSERT INTO kv VALUES (?, ?)');
    put.run('assets/image', Buffer.from('module-0001'));
    put.run('cache/image', Buffer.from('module-0001'));
    put.run('migration-backup/old', Buffer.from('module-0001'));
    put.run('plugin-storage/live', Buffer.from('module-0002'));
    put.run('drafts/live', Buffer.from('module-0002'));
    sqlite.pragma('query_only = ON');
    const result = externalReferenceAudit(sqlite, ['module-0001', 'module-0002']);
    assert.equal(result.checkedKeys, 2);
    assert.equal(result.counts.get('module-0001'), 0);
    assert.equal(result.counts.get('module-0002'), 2);
    sqlite.close();
});

function fixtureDb(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-module-audit-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'test.db');
    const sqlite = new Database(dbPath);
    sqlite.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value BLOB NOT NULL,updated_at INTEGER); CREATE TABLE chunks(hash TEXT PRIMARY KEY,data BLOB); CREATE TABLE manifest_chunks(manifest_key TEXT,seq INTEGER,hash TEXT,PRIMARY KEY(manifest_key,seq))');
    const raw = input(database());
    sqlite.prepare('INSERT INTO kv VALUES (?, ?, 0)').run('database/database.bin', raw);
    sqlite.close();
    return { dbPath, raw, sha: crypto.createHash('sha256').update(raw).digest('hex') };
}

function cli(dbPath, args = []) {
    return spawnSync(process.execPath, [path.join(__dirname, 'quarantine-exact-module-duplicates.cjs'), dbPath, ...args], { encoding: 'utf8' });
}

test('CLI dry run leaves records untouched and stale-hash apply is refused', t => {
    const fixture = fixtureDb(t);
    const dry = cli(fixture.dbPath);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).removed, 1);
    const wrong = cli(fixture.dbPath, ['--apply', '--offline-confirmed', '--expected-sha', '0'.repeat(64)]);
    assert.notEqual(wrong.status, 0);
    const sqlite = new Database(fixture.dbPath, { readonly: true });
    assert.deepEqual(sqlite.prepare('SELECT value FROM kv WHERE key=?').get('database/database.bin').value, fixture.raw);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM kv').get().count, 1);
    sqlite.close();
});

test('CLI apply saves snapshot/archive and merge restore preserves subsequent unrelated writes', t => {
    const fixture = fixtureDb(t);
    const applied = cli(fixture.dbPath, ['--apply', '--offline-confirmed', '--expected-sha', fixture.sha]);
    assert.equal(applied.status, 0, applied.stderr);
    const result = JSON.parse(applied.stdout);
    const sqlite = new Database(fixture.dbPath);
    assert.deepEqual(sqlite.prepare('SELECT value FROM kv WHERE key=?').get(result.backupKey).value, fixture.raw);
    const archive = JSON.parse(sqlite.prepare('SELECT value FROM kv WHERE key=?').get(result.archiveKey).value.toString());
    assert.equal(archive.removed[0].module.id, 'module-0002');
    const later = object(sqlite.prepare('SELECT value FROM kv WHERE key=?').get('database/database.bin').value);
    later.characters[0].laterEdit = 'preserve me';
    const laterRaw = input(later);
    sqlite.prepare('UPDATE kv SET value=? WHERE key=?').run(laterRaw, 'database/database.bin');
    sqlite.close();
    const expected = crypto.createHash('sha256').update(laterRaw).digest('hex');
    const restored = cli(fixture.dbPath, ['--restore', result.archiveKey, '--apply', '--offline-confirmed', '--expected-sha', expected]);
    assert.equal(restored.status, 0, restored.stderr);
    const reader = new Database(fixture.dbPath, { readonly: true });
    const after = object(reader.prepare('SELECT value FROM kv WHERE key=?').get('database/database.bin').value);
    assert.equal(after.modules.length, 2);
    assert.equal(after.characters[0].laterEdit, 'preserve me');
    reader.close();
});

test('CLI write failure rolls back snapshot, archive and database together', t => {
    const fixture = fixtureDb(t);
    const sqlite = new Database(fixture.dbPath);
    sqlite.exec("CREATE TRIGGER fail_main_write BEFORE INSERT ON kv WHEN NEW.key = 'database/database.bin' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    sqlite.close();
    const result = cli(fixture.dbPath, ['--apply', '--offline-confirmed', '--expected-sha', fixture.sha]);
    assert.notEqual(result.status, 0);
    const reader = new Database(fixture.dbPath, { readonly: true });
    assert.equal(reader.prepare('SELECT count(*) AS count FROM kv').get().count, 1);
    assert.deepEqual(reader.prepare('SELECT value FROM kv WHERE key=?').get('database/database.bin').value, fixture.raw);
    reader.close();
});
