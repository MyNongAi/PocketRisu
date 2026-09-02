'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { decodeRisuSave } = require('../server/node/utils.cjs');

const dbPath = process.argv[2];
if (!dbPath) throw new Error('Usage: node tools/inspect-module-folders.cjs <risuai.db>');

const db = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });
const keys = db.prepare(`
    SELECT key, updated_at
    FROM kv
    WHERE key = 'database/database.bin'
       OR key LIKE 'database/dbbackup-%'
       OR key LIKE 'migration-backup/pre-module-folder-repair-%'
    ORDER BY updated_at DESC
`).all();
const rawValue = db.prepare('SELECT value FROM kv WHERE key = ?');
const chunksFor = db.prepare(`
    SELECT c.data
    FROM manifest_chunks AS m
    JOIN chunks AS c ON c.hash = m.hash
    WHERE m.manifest_key = ?
    ORDER BY m.seq
`);

function readValue(key) {
    const rows = chunksFor.all(key);
    if (rows.length > 0) return Buffer.concat(rows.map((row) => row.data));
    return rawValue.get(key)?.value ?? null;
}

function summarize(value, key, updatedAt) {
    const modules = Array.isArray(value?.modules) ? value.modules : [];
    const folders = Array.isArray(value?.moduleFolders) ? value.moduleFolders : [];
    const folderIds = new Set(folders.map((folder) => folder?.id).filter(Boolean));
    const byFolder = new Map(folders.map((folder) => [folder.id, {
        id: folder.id,
        name: folder.name ?? '',
        count: 0,
        memberListCount: Array.isArray(folder?.moduleIds) ? folder.moduleIds.length : 0,
        duplicateKind: folder.duplicateCandidate?.kind ?? null,
        duplicateKey: folder.duplicateCandidate?.key ?? null,
    }]));
    let assigned = 0;
    let orphaned = 0;
    const sourceCounts = new Map();
    let modulesWithMissingAssets = 0;
    const listedModuleIds = new Set();
    for (const folder of folders) {
        if (!Array.isArray(folder?.moduleIds)) continue;
        for (const moduleId of folder.moduleIds) listedModuleIds.add(moduleId);
    }
    for (const module of modules) {
        const label = typeof module?.sourceInfo?.label === 'string' ? module.sourceInfo.label : '(없음)';
        sourceCounts.set(label, (sourceCounts.get(label) ?? 0) + 1);
        if (Number(module?.sourceInfo?.missingAssetCount) > 0) modulesWithMissingAssets++;
        if (!module?.folderId) continue;
        assigned++;
        const bucket = byFolder.get(module.folderId);
        if (bucket) bucket.count++;
        else orphaned++;
    }
    return {
        key,
        updatedAt,
        modules: modules.length,
        folders: folders.length,
        assigned,
        uncategorized: modules.length - assigned,
        orphaned,
        existingFolderAssignments: assigned - orphaned,
        listedAssignments: listedModuleIds.size,
        sourceCounts: Object.fromEntries(sourceCounts),
        modulesWithMissingAssets,
        folderCounts: [...byFolder.values()],
        ...(process.argv.includes('--full') ? {
            moduleAssignments: modules.map((module, index) => ({
                index,
                id: module?.id ?? null,
                name: module?.name ?? '',
                folderId: module?.folderId ?? null,
                folderExists: module?.folderId ? folderIds.has(module.folderId) : false,
                sourceInfo: module?.sourceInfo ?? null,
            })),
        } : {}),
    };
}

(async () => {
    const summaries = [];
    for (const row of keys) {
        const raw = readValue(row.key);
        if (!raw) continue;
        const decoded = await decodeRisuSave(raw);
        summaries.push(summarize(decoded, row.key, row.updated_at));
    }
    process.stdout.write(JSON.stringify(summaries, null, 2));
    db.close();
})().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});
