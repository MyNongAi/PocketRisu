'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { createChunkStore } = require('../server/node/chunkStore.cjs');
const { decodeRisuSave, encodeRisuSaveLegacy, normalizeJSON } = require('../server/node/utils.cjs');

const dbPath = process.argv[2];
const apply = process.argv.includes('--apply');
if (!dbPath) throw new Error('Usage: node tools/repair-module-folders.cjs <risuai.db> [--apply]');

function normalizeName(value) {
    if (typeof value !== 'string') return '';
    return value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s_]+/gu, '');
}

function similarity(left, right) {
    const a = normalizeName(left);
    const b = normalizeName(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const longest = Math.max(a.length, b.length);
    if (longest < 5 || Math.abs(a.length - b.length) / longest > 0.1) return 0;
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let row = 1; row <= a.length; row++) {
        const current = [row];
        for (let column = 1; column <= b.length; column++) {
            current[column] = Math.min(
                current[column - 1] + 1,
                previous[column] + 1,
                previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
            );
        }
        previous = current;
    }
    return 1 - previous[b.length] / longest;
}

function similarityGroups(modules, threshold = 0.9) {
    const valid = modules
        .map((module, sourceIndex) => ({ module, sourceIndex, normalized: normalizeName(module?.name) }))
        .filter((entry) => entry.normalized);
    const parent = valid.map((_, index) => index);
    const find = (index) => {
        while (parent[index] !== index) {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }
        return index;
    };
    const union = (left, right) => {
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot === rightRoot) return;
        if (valid[leftRoot].sourceIndex <= valid[rightRoot].sourceIndex) parent[rightRoot] = leftRoot;
        else parent[leftRoot] = rightRoot;
    };
    for (let left = 0; left < valid.length; left++) {
        for (let right = left + 1; right < valid.length; right++) {
            const longest = Math.max(valid[left].normalized.length, valid[right].normalized.length);
            if (Math.abs(valid[left].normalized.length - valid[right].normalized.length) / longest > 0.1) continue;
            if (similarity(valid[left].normalized, valid[right].normalized) >= threshold) union(left, right);
        }
    }
    const grouped = new Map();
    for (let index = 0; index < valid.length; index++) {
        const root = find(index);
        const members = grouped.get(root) ?? [];
        members.push(valid[index]);
        grouped.set(root, members);
    }
    return [...grouped.values()]
        .filter((group) => group.length > 1)
        .map((group) => {
            group.sort((left, right) => left.sourceIndex - right.sourceIndex);
            return { key: group[0].normalized, modules: group.map((entry) => entry.module) };
        });
}

function repairAssignments(dbObject) {
    const modules = Array.isArray(dbObject.modules) ? dbObject.modules : [];
    const folders = Array.isArray(dbObject.moduleFolders) ? dbObject.moduleFolders : [];
    const byName = new Map(folders.map((folder) => [folder.name, folder]));
    const required = [
        '[에셋 누락] 모바일웹리스', '[출처] 모바일웹리스',
        '[에셋 누락] 로컬리스', '[출처] 로컬리스',
        '소녀전선', '동방', '롤리폴리스',
    ];
    const missingFolders = required.filter((name) => !byName.has(name));
    if (missingFolders.length > 0) throw new Error(`Required module folders are missing: ${missingFolders.join(', ')}`);

    // Preserve the established folder.memberIds relationship before rebuilding
    // both representations. This is exact historical membership evidence and
    // must win over source/name heuristics.
    const preservedMembership = new Map();
    for (const folder of folders) {
        if (!Array.isArray(folder?.moduleIds)) continue;
        for (const moduleId of folder.moduleIds) {
            if (typeof moduleId === 'string' && moduleId && !preservedMembership.has(moduleId)) {
                preservedMembership.set(moduleId, folder.id);
            }
        }
    }

    // Rebuild both relationship representations used by PocketRisu. The
    // settings page reads module.folderId while the chat/sidebar catalog reads
    // folder.moduleIds; keeping only one was the cause of the empty folders.
    for (const module of modules) delete module.folderId;
    for (const folder of folders) folder.moduleIds = [];

    if (preservedMembership.size > 0) {
        for (const module of modules) {
            const folderId = preservedMembership.get(module?.id);
            if (folderId) module.folderId = folderId;
        }
    } else {

    // 1) Imported source provenance is exact evidence retained on every entity.
    for (const module of modules) {
        const label = module?.sourceInfo?.label;
        const sourceFolder = label === '로컬리스'
            ? byName.get('[출처] 로컬리스')
            : label === '모바일웹리스'
                ? byName.get('[출처] 모바일웹리스')
                : null;
        if (sourceFolder) module.folderId = sourceFolder.id;
    }

    // 2) Recreate review groups from their preserved matching key.
    const groups = new Map(similarityGroups(modules).map((group) => [group.key, group.modules]));
    for (const folder of folders) {
        if (folder?.duplicateCandidate?.kind !== 'module') continue;
        const members = groups.get(folder.duplicateCandidate.key) ?? [];
        for (const module of members) module.folderId = folder.id;
    }

    // 3) Restore the three manually named theme folders conservatively from
    // explicit theme words in module titles.
    const manualMatchers = [
        [byName.get('소녀전선'), (name) => name.includes('소녀전선')],
        [byName.get('동방'), (name) => name.includes('동방') || name.includes('touhou') || name.includes('gensokyo')],
        [byName.get('롤리폴리스'), (name) => name.includes('롤리폴리스') || name.includes('lollipolis')],
    ];
    for (const module of modules) {
        const name = String(module?.name ?? '').normalize('NFKC').toLocaleLowerCase();
        for (const [folder, matches] of manualMatchers) {
            if (matches(name)) module.folderId = folder.id;
        }
    }

    // 4) Missing-asset audit is the strongest operational grouping and wins
    // over provenance/theme folders so broken imports stay easy to find.
    for (const module of modules) {
        if (!(Number(module?.sourceInfo?.missingAssetCount) > 0)) continue;
        const label = module?.sourceInfo?.label;
        const missingFolder = label === '로컬리스'
            ? byName.get('[에셋 누락] 로컬리스')
            : label === '모바일웹리스'
                ? byName.get('[에셋 누락] 모바일웹리스')
                : null;
        if (missingFolder) module.folderId = missingFolder.id;
    }
    }

    const folderById = new Map(folders.map((folder) => [folder.id, folder]));
    for (const module of modules) {
        if (!module?.folderId || !module?.id) continue;
        const folder = folderById.get(module.folderId);
        if (folder) folder.moduleIds.push(module.id);
    }

    const counts = folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        count: modules.filter((module) => module.folderId === folder.id).length,
    }));
    return {
        modules: modules.length,
        assigned: modules.filter((module) => module.folderId).length,
        uncategorized: modules.filter((module) => !module.folderId).length,
        counts,
    };
}

(async () => {
    const sqlite = new Database(path.resolve(dbPath), { fileMustExist: true });
    const store = createChunkStore(sqlite);
    const raw = store.getValue('database/database.bin');
    if (!raw) throw new Error('database/database.bin is missing');
    const decoded = await decodeRisuSave(raw);
    const result = repairAssignments(decoded);
    const encoded = Buffer.from(encodeRisuSaveLegacy(normalizeJSON(decoded)));
    const roundTripped = await decodeRisuSave(encoded);
    const verifiedAssigned = (roundTripped.modules ?? []).filter((module) => module?.folderId).length;
    const verifiedListed = new Set((roundTripped.moduleFolders ?? []).flatMap((folder) => folder?.moduleIds ?? [])).size;
    if (verifiedAssigned !== result.assigned) {
        throw new Error(`Folder assignment round-trip failed: expected ${result.assigned}, got ${verifiedAssigned}`);
    }
    if (verifiedListed !== result.assigned) {
        throw new Error(`Folder member-list round-trip failed: expected ${result.assigned}, got ${verifiedListed}`);
    }
    let safetyBackupKey = null;
    if (apply) {
        safetyBackupKey = `migration-backup/pre-module-folder-repair-${Date.now()}.bin`;
        store.snapshotValue('database/database.bin', safetyBackupKey);
        store.putValue('database/database.bin', encoded);
    }
    process.stdout.write(JSON.stringify({ apply, safetyBackupKey, verifiedAssigned, verifiedListed, ...result }, null, 2));
    sqlite.close();
})().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});
