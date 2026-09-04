'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Packr, Unpackr } = require('msgpackr');
const Database = require('better-sqlite3');
const { HEADER, skipValue, signatureFor, auditBuffer, loadVerifiedManifest, readChunkedValue } = require('./audit-exact-module-duplicates.cjs');
const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false, int64AsType: 'number' });
const encode = db => Buffer.concat([HEADER, packr.encode(db)]);
const audit = (db, options) => auditBuffer(encode(db), bytes => unpackr.decode(bytes), options);
const moduleOf = (id, overrides = {}) => ({ id, name: 'Same', description: '', lorebook: [{ key: 'x', content: 'exact', enabled: true }],
    assets: [['x', 'external://disk/hash', 'png']], ...overrides });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('comparison ignores only copy identity, provenance and folder; no input mutation', () => {
    const one = moduleOf('module-0001', { sourceInfo: { missingAssetCount: 1 }, folderId: 'folder-a' });
    const two = moduleOf('module-0002', { sourceInfo: { missingAssetCount: 0 }, folderId: 'folder-b' });
    const db = { modules: [one, two] };
    const before = JSON.stringify(db);
    const result = audit(db);
    assert.equal(result.exactGroups, 1);
    assert.equal(result.duplicateCopies, 1);
    assert.equal(JSON.stringify(db), before);
});

test('lore flags/text/order, asset count/name/path/order and new fields all prevent equality', () => {
    const base = moduleOf('module-0001');
    const variants = [
        { lorebook: [{ key: 'x', content: 'exact', enabled: false }] },
        { lorebook: [{ key: 'x', content: 'exact ' }] },
        { assets: [['x', 'external://disk/other', 'png']] },
        { assets: [['y', 'external://disk/hash', 'png']] },
        { assets: [['x', 'external://disk/hash', 'png'], ['x', 'external://disk/hash', 'png']] },
        { titleColor: '#ff0000' }, { favorite: true }, { namespace: 'other' }, { cjs: 'return 1' },
    ];
    for (const fields of variants) assert.equal(audit({ modules: [base, moduleOf('module-0002', fields)] }).exactGroups, 0);
    assert.notEqual(signatureFor({ id: 'x', lorebook: [1, 2] }), signatureFor({ id: 'y', lorebook: [2, 1] }));
    assert.notEqual(signatureFor({ id: 'x', assets: [['a', 'b'], ['c', 'd']] }), signatureFor({ id: 'y', assets: [['c', 'd'], ['a', 'b']] }));
});

test('root key order and nested object key order do not prevent exact equality', () => {
    assert.equal(signatureFor({ id: 'a', lorebook: [{ a: 1, b: 2 }] }), signatureFor({ lorebook: [{ b: 2, a: 1 }], id: 'b' }));
});

test('global, character, chat, model-binding and literal script references are flagged', () => {
    const db = { modules: [moduleOf('module-0001'), moduleOf('module-0002')],
        enabledModules: ['module-0001'], characters: [{ modules: ['module-0002'], chats: [{ modules: ['module-0002'] }] }],
        moduleModelBindings: { 'module-0001': 'preset' }, plugins: ['getModule("module-0002")'] };
    const result = audit(db);
    assert.equal(result.groupsWithDirectReferences, 1);
    assert.equal(result.groups[0].members[0].directReferences, 2);
    assert.equal(result.groups[0].members[1].directReferences, 3);
});

test('folder membership and display history do not count as functional references', () => {
    const result = audit({ modules: [moduleOf('module-0001'), moduleOf('module-0002')],
        moduleFolders: [{ moduleIds: ['module-0001', 'module-0002'] }], moduleActivationHistory: ['module-0002'] });
    assert.equal(result.groupsWithDirectReferences, 0);
    assert.deepEqual(result.groups[0].members.map(member => member.directReferences), [0, 0]);
});

test('duplicate module identities are never treated as independently safe', () => {
    const result = audit({ modules: [moduleOf('module-0001'), moduleOf('module-0001')] });
    assert.equal(result.groups[0].requiresReview, true);
    assert.equal(result.groups[0].members[0].ambiguousIdentity, true);
});

test('missing or failed manifests skip comparison; verified descriptors compare actual assets', () => {
    const withManifest = moduleOf('module-0001', { assets: undefined, assetManifest: { id: 'manifest' } });
    delete withManifest.assets;
    assert.equal(audit({ modules: [withManifest, moduleOf('module-0002')] }).skipped.length, 1);
    const options = { loadManifest: () => [['x', 'external://disk/hash', 'png']] };
    assert.equal(audit({ modules: [withManifest, moduleOf('module-0002')] }, options).exactGroups, 1);
    assert.throws(() => signatureFor({ ...withManifest, assets: [] }, options.loadManifest), /disagree/);
});

test('undefined/NaN/non-JSON definitions cannot collapse to a matching signature', () => {
    assert.throws(() => signatureFor({ id: 'a', x: undefined }));
    assert.throws(() => signatureFor({ id: 'a', x: NaN }));
    assert.throws(() => signatureFor({ id: 'a', x: Buffer.from('a') }));
});

test('scanner handles large maps/arrays/strings/bin and rejects truncated inputs', () => {
    const values = [null, true, false, -99, 1.5, 70000, 'x'.repeat(70000), Buffer.alloc(70000),
        Array.from({ length: 80 }, (_, i) => i), Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['k' + i, [i]]))];
    for (const value of values) {
        const buffer = packr.encode(value);
        assert.equal(skipValue(buffer, 0), buffer.length);
        if (buffer.length > 1) assert.throws(() => skipValue(buffer.subarray(0, buffer.length - 1), 0));
    }
    assert.throws(() => auditBuffer(Buffer.from('unsupported'), bytes => unpackr.decode(bytes)), /v7 only/);
    assert.throws(() => auditBuffer(Buffer.concat([encode({ modules: [] }), Buffer.from([0])]), bytes => unpackr.decode(bytes)), /Unexpected bytes/);
});

test('manifest integrity validation includes content, ownership, count and descriptor values', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE asset_manifests (manifest_id TEXT, owner_kind TEXT, owner_id TEXT, format_version INTEGER, item_count INTEGER, content_hash TEXT, raw_bytes INTEGER, payload BLOB)');
    const items = [['x', 'assets/x', 'png']];
    const raw = Buffer.from(JSON.stringify(items));
    const hash = sha(raw);
    const id = sha(`module\0module-0001\0${hash}`);
    sqlite.prepare('INSERT INTO asset_manifests VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'module', 'module-0001', 1, 1, hash, raw.length, zlib.deflateRawSync(raw));
    const descriptor = { id, sha256: hash, count: 1, version: 1, ownerKind: 'module', ownerId: 'module-0001' };
    assert.deepEqual(loadVerifiedManifest(sqlite, descriptor, 'module-0001'), items);
    assert.throws(() => loadVerifiedManifest(sqlite, { ...descriptor, count: 2 }, 'module-0001'));
    assert.throws(() => loadVerifiedManifest(sqlite, descriptor, 'module-0002'));
    sqlite.prepare('UPDATE asset_manifests SET content_hash=?').run('bad');
    assert.throws(() => loadVerifiedManifest(sqlite, descriptor, 'module-0001'));
    sqlite.close();
});

test('chunk reader copies rows in sequence and leaves SQLite untouched', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE kv (key TEXT, value BLOB); CREATE TABLE chunks (hash TEXT, data BLOB); CREATE TABLE manifest_chunks (manifest_key TEXT, seq INTEGER, hash TEXT)');
    sqlite.prepare('INSERT INTO chunks VALUES (?, ?)').run(sha('hello'), Buffer.from('hello'));
    sqlite.prepare('INSERT INTO chunks VALUES (?, ?)').run(sha('world'), Buffer.from('world'));
    sqlite.prepare('INSERT INTO manifest_chunks VALUES (?, ?, ?)').run('db', 1, sha('world'));
    sqlite.prepare('INSERT INTO manifest_chunks VALUES (?, ?, ?)').run('db', 0, sha('hello'));
    sqlite.prepare('INSERT INTO kv VALUES (?, ?)').run('db', Buffer.from('\0RISUCHUNKED\0', 'binary'));
    sqlite.pragma('query_only = ON');
    assert.equal(readChunkedValue(sqlite, 'db').toString(), 'helloworld');
    assert.equal(readChunkedValue(sqlite, 'none'), null);
    sqlite.close();
});

test('raw overwrite takes precedence over stale chunk rows and broken marker fails closed', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE kv (key TEXT, value BLOB); CREATE TABLE chunks (hash TEXT, data BLOB); CREATE TABLE manifest_chunks (manifest_key TEXT, seq INTEGER, hash TEXT)');
    sqlite.prepare('INSERT INTO kv VALUES (?, ?)').run('raw', Buffer.from('current'));
    sqlite.prepare('INSERT INTO chunks VALUES (?, ?)').run('old', Buffer.from('stale'));
    sqlite.prepare('INSERT INTO manifest_chunks VALUES (?, ?, ?)').run('raw', 0, 'old');
    sqlite.prepare('INSERT INTO kv VALUES (?, ?)').run('broken', Buffer.from('\0RISUCHUNKED\0', 'binary'));
    assert.equal(readChunkedValue(sqlite, 'raw').toString(), 'current');
    assert.throws(() => readChunkedValue(sqlite, 'broken'), /no complete payload/);
    sqlite.close();
});
