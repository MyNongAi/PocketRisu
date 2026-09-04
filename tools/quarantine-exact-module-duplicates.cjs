'use strict';

// Offline maintenance only. "Quarantine" here means a recoverable archive,
// NOT PocketRisu's native character trash (modules have no native trash).
const crypto = require('node:crypto');
const path = require('node:path');
const { createRequire } = require('node:module');
const { HEADER, mapFields, auditBuffer, loadVerifiedManifest, readChunkedValue } = require('./audit-exact-module-duplicates.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const COPY_FIELDS = ['modules', 'moduleFolders', 'moduleActivationHistory'];

function selectedFields(raw, decode) {
    const root = mapFields(raw, HEADER.length, decode);
    return { root, data: Object.fromEntries(COPY_FIELDS.flatMap(key => {
        const span = root.fields.get(key);
        return span ? [[key, decode(raw.subarray(span.start, span.end))]] : [];
    })) };
}

// Replace only existing top-level values. All unrelated encoded fields,
// including API keys, characters, chats and plugin data, are byte-preserved.
function replaceFields(raw, replacements, decode, encode) {
    const { fields } = mapFields(raw, HEADER.length, decode);
    const pieces = [];
    let cursor = 0;
    for (const [key, span] of fields) {
        if (!Object.hasOwn(replacements, key)) continue;
        pieces.push(raw.subarray(cursor, span.start), encode(replacements[key]));
        cursor = span.end;
    }
    for (const key of Object.keys(replacements)) {
        if (!fields.has(key)) throw new Error(`Cannot add missing root field ${key} with bounded writer`);
    }
    pieces.push(raw.subarray(cursor));
    return Buffer.concat(pieces);
}

function externalReferenceAudit(sqlite, ids) {
    const needles = ids.map(id => [id, Buffer.from(id)]);
    const counts = new Map(ids.map(id => [id, 0]));
    let checkedKeys = 0;
    // Do not read images, generated caches or historical backup payloads.
    const rows = sqlite.prepare(`SELECT key FROM kv WHERE
        key NOT LIKE 'assets/%' AND key NOT LIKE 'cache/%' AND key NOT LIKE 'database/%'
        AND key NOT LIKE 'migration-backup/%' AND key NOT LIKE 'migration/%'
        AND key NOT LIKE 'plugin-storage-snapshot/%'`).all();
    for (const { key } of rows) {
        const raw = readChunkedValue(sqlite, key);
        if (!raw) continue;
        if (raw.length > 16 * 1024 * 1024) throw new Error('Large opaque non-asset record requires manual reference review');
        checkedKeys++;
        for (const [id, needle] of needles) {
            if (Buffer.from(key).includes(needle) || raw.includes(needle)) counts.set(id, counts.get(id) + 1);
        }
    }
    return { checkedKeys, counts };
}

function prepareRemoval(raw, decode, encode, options = {}) {
    const audit = auditBuffer(raw, decode, options);
    const { root, data } = selectedFields(raw, decode);
    const removed = [];
    const blocked = [];
    const retained = [];
    for (const group of audit.groups) {
        const members = [...group.members].sort((a, b) => {
            const missingA = Math.max(0, Number(data.modules[a.index]?.sourceInfo?.missingAssetCount) || 0);
            const missingB = Math.max(0, Number(data.modules[b.index]?.sourceInfo?.missingAssetCount) || 0);
            return missingA - missingB || a.index - b.index;
        });
        if (members.some(member => member.directReferences || member.ambiguousIdentity
            || (options.externalReferences?.get(member.id) ?? 0) > 0)) {
            blocked.push({ definitionHash: group.definitionHash, ids: members.map(member => member.id) });
            continue;
        }
        retained.push(members[0].id);
        for (const member of members.slice(1)) removed.push({ index: member.index, module: data.modules[member.index] });
    }
    const removedIds = new Set(removed.map(entry => entry.module.id));
    const replacements = { modules: data.modules.filter(module => !removedIds.has(module.id)) };
    if (root.fields.has('moduleFolders')) replacements.moduleFolders = (data.moduleFolders ?? []).map(folder => ({
        ...folder, ...(Array.isArray(folder.moduleIds) ? { moduleIds: folder.moduleIds.filter(id => !removedIds.has(id)) } : {}),
    }));
    if (root.fields.has('moduleActivationHistory')) replacements.moduleActivationHistory = (data.moduleActivationHistory ?? []).filter(id => !removedIds.has(id));
    const next = removed.length ? replaceFields(raw, replacements, decode, encode) : raw;
    const archive = { format: 'pocketrisu-exact-module-quarantine-v1', createdAt: Date.now(),
        beforeSha256: sha(raw), afterSha256: sha(next), removed, retainedIds: retained,
        moduleFolders: data.moduleFolders ?? [], moduleActivationHistory: data.moduleActivationHistory ?? [],
        note: 'Only exact, unreferenced module records removed. Asset files/manifests are untouched. Restore is module-only merge.' };
    return { next, archive, blocked, audit };
}

function prepareRestore(raw, archive, decode, encode) {
    if (archive?.format !== 'pocketrisu-exact-module-quarantine-v1' || !Array.isArray(archive.removed)) {
        throw new Error('Unrecognized module quarantine archive');
    }
    const { root, data } = selectedFields(raw, decode);
    const modules = [...(data.modules ?? [])];
    const byId = new Map(modules.map(module => [module.id, module]));
    const restored = [];
    const canonical = value => JSON.stringify(value);
    for (const entry of archive.removed) {
        if (!entry?.module?.id) throw new Error('Archived module lacks identity');
        const existing = byId.get(entry.module.id);
        if (existing) {
            if (canonical(existing) !== canonical(entry.module)) throw new Error('Restoration identity is already used by a changed module');
            continue;
        }
        // Append restored records; do not renumber/reorder current unrelated modules.
        const restoredModule = structuredClone(entry.module);
        modules.push(restoredModule); byId.set(restoredModule.id, restoredModule); restored.push(restoredModule);
    }
    const replacements = { modules };
    if (restored.some(module => module.folderId) && !root.fields.has('moduleFolders')) {
        throw new Error('Folder root field is missing; refusing a partial folder restoration');
    }
    if (root.fields.has('moduleFolders')) {
        const folders = structuredClone(data.moduleFolders ?? []);
        for (const module of restored) {
            if (!module.folderId) continue;
            let folder = folders.find(item => item.id === module.folderId);
            if (!folder) {
                const old = archive.moduleFolders.find(item => item.id === module.folderId);
                if (!old) throw new Error('Archived module folder is unavailable');
                folder = { ...structuredClone(old), moduleIds: [] }; folders.push(folder);
            }
            folder.moduleIds ??= [];
            if (!folder.moduleIds.includes(module.id)) folder.moduleIds.push(module.id);
        }
        replacements.moduleFolders = folders;
    }
    if (root.fields.has('moduleActivationHistory')) {
        const restoredIds = new Set(restored.map(module => module.id));
        const current = data.moduleActivationHistory ?? [];
        const priorRestored = archive.moduleActivationHistory.filter(id => restoredIds.has(id) && !current.includes(id));
        // Old restored entries stay older than later activity.
        replacements.moduleActivationHistory = [...priorRestored, ...current];
    }
    return { next: restored.length ? replaceFields(raw, replacements, decode, encode) : raw, restored: restored.length };
}

function main() {
    const args = process.argv.slice(2);
    const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
    if (!args[0]) throw new Error('Usage: node tools/quarantine-exact-module-duplicates.cjs <db> [--runtime-root <repo>] [--apply --offline-confirmed --expected-sha <sha>] [--restore <archive-key>]');
    const apply = args.includes('--apply');
    const expected = option('--expected-sha');
    const restoreKey = option('--restore');
    if (apply && (!args.includes('--offline-confirmed') || !/^[a-f0-9]{64}$/.test(expected ?? ''))) {
        throw new Error('Apply requires stopped server/clients, --offline-confirmed and exact --expected-sha from a fresh dry run');
    }
    if (restoreKey && !restoreKey.startsWith('migration-backup/exact-modules-')) throw new Error('Unexpected restore archive key');
    const runtimeRequire = createRequire(path.join(path.resolve(option('--runtime-root') || path.resolve(__dirname, '..')), 'package.json'));
    const Database = runtimeRequire('better-sqlite3');
    const { Packr, Unpackr } = runtimeRequire('msgpackr');
    const packr = new Packr({ useRecords: false });
    const unpackr = new Unpackr({ useRecords: false, int64AsType: 'number' });
    const decode = bytes => unpackr.decode(bytes);
    const encode = value => Buffer.from(packr.encode(value));
    const sqlite = new Database(path.resolve(args[0]), { readonly: !apply, fileMustExist: true });
    if (!apply) sqlite.pragma('query_only = ON');
    sqlite.exec(apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
    let committed = false;
    try {
        const raw = readChunkedValue(sqlite, 'database/database.bin');
        if (!raw) throw new Error('database/database.bin is missing');
        const sourceSha256 = sha(raw);
        if (apply && sourceSha256 !== expected) throw new Error('Database changed since audit; run a fresh dry run');
        let next;
        let archive;
        let summary;
        if (restoreKey) {
            const bytes = readChunkedValue(sqlite, restoreKey);
            if (!bytes) throw new Error('Restore archive not found');
            const result = prepareRestore(raw, JSON.parse(bytes.toString('utf8')), decode, encode);
            next = result.next;
            summary = { restored: result.restored, restoreKey };
        } else {
            const options = { loadManifest: (descriptor, id) => loadVerifiedManifest(sqlite, descriptor, id) };
            const audit = auditBuffer(raw, decode, options);
            const external = externalReferenceAudit(sqlite, audit.groups.flatMap(group => group.members.map(member => member.id)));
            const result = prepareRemoval(raw, decode, encode, { ...options, externalReferences: external.counts });
            next = result.next; archive = result.archive;
            summary = { totalModules: result.audit.totalModules, exactGroups: result.audit.exactGroups,
                removed: archive.removed.length, remaining: result.audit.totalModules - archive.removed.length,
                blockedGroups: result.blocked.length, externalKeysChecked: external.checkedKeys,
                caveat: 'Plain ID references are checked; script-computed IDs and opaque external systems cannot be proven absent.' };
        }
        let backupKey = null;
        let archiveKey = null;
        if (apply && next !== raw) {
            const { createChunkStore } = require('../server/node/chunkStore.cjs');
            const store = createChunkStore(sqlite);
            const stamp = Date.now();
            backupKey = `migration-backup/pre-exact-module-${restoreKey ? 'restore' : 'quarantine'}-${stamp}.bin`;
            store.snapshotValue('database/database.bin', backupKey);
            if (archive) {
                archiveKey = `migration-backup/exact-modules-${stamp}.json`;
                store.putValue(archiveKey, Buffer.from(JSON.stringify(archive)));
            }
            store.putValue('database/database.bin', next);
            if (sha(readChunkedValue(sqlite, 'database/database.bin')) !== sha(next)) throw new Error('Written database did not verify');
            sqlite.exec('COMMIT'); committed = true;
        }
        process.stdout.write(JSON.stringify({ apply, sourceSha256, nextSha256: sha(next), backupKey, archiveKey,
            assetsDeleted: 0, nativeModuleTrash: false, ...summary }, null, 2) + '\n');
    } finally { if (!committed) sqlite.exec('ROLLBACK'); sqlite.close(); }
}

module.exports = { replaceFields, selectedFields, externalReferenceAudit, prepareRemoval, prepareRestore };
if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
