'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { decodeRisuSave } = require('../server/node/utils.cjs');

const dbPath = path.resolve(process.argv[2] || 'save/risuai.db');
const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
const rawValue = sqlite.prepare('SELECT value FROM kv WHERE key = ?');
const chunksFor = sqlite.prepare(`
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

function realmId(character) {
    const value = character?.realmId
        ?? character?.extentions?.risuRealmImportId
        ?? character?.extensions?.risuRealmImportId;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isMobileLabel(label) {
    return /mobile|모바일/i.test(String(label ?? ''));
}

(async () => {
    const raw = readValue('database/database.bin');
    if (!raw) throw new Error('database/database.bin not found');
    const db = await decodeRisuSave(raw);
    const characters = Array.isArray(db.characters) ? db.characters : [];
    const byId = new Map(characters.map((character, index) => [character?.chaId, { character, index }]));
    const sourceCounts = new Map();
    for (const character of characters) {
        const label = String(character?.sourceInfo?.label ?? '(없음)');
        const bucket = sourceCounts.get(label) ?? { total: 0, active: 0, trashed: 0, missing: 0, exactRealm: 0 };
        bucket.total++;
        if (character?.trashTime) bucket.trashed++; else bucket.active++;
        if (Number(character?.sourceInfo?.missingAssetCount) > 0) bucket.missing++;
        if (realmId(character)) bucket.exactRealm++;
        sourceCounts.set(label, bucket);
    }

    const folders = (Array.isArray(db.characterOrder) ? db.characterOrder : [])
        .filter((entry) => entry && typeof entry !== 'string')
        .map((folder, orderIndex) => {
            const members = (Array.isArray(folder.data) ? folder.data : [])
                .map((id) => byId.get(id))
                .filter(Boolean);
            return {
                orderIndex,
                id: folder.id,
                name: folder.name ?? '',
                members: members.length,
                missing: members.filter(({ character }) => Number(character?.sourceInfo?.missingAssetCount) > 0).length,
                exactRealm: members.filter(({ character }) => Boolean(realmId(character))).length,
                mobileLabels: members.filter(({ character }) => isMobileLabel(character?.sourceInfo?.label)).length,
            };
        });

    const mobileSourceIds = new Set(characters
        .filter((character) => !character?.trashTime && isMobileLabel(character?.sourceInfo?.label))
        .map((character) => character.chaId));
    const mobileFolderIds = new Set();
    for (const folder of folders.filter((folder) => isMobileLabel(folder.name))) {
        const source = db.characterOrder[folder.orderIndex];
        for (const id of source.data ?? []) mobileFolderIds.add(id);
    }
    const targetIds = new Set([...mobileSourceIds, ...mobileFolderIds]);
    const targets = [...targetIds]
        .map((id) => byId.get(id))
        .filter(({ character }) => !character?.trashTime)
        .map(({ character, index }) => ({
            index,
            chaId: character.chaId,
            name: character.name ?? '',
            sourceLabel: character?.sourceInfo?.label ?? null,
            missing: Number(character?.sourceInfo?.missingAssetCount) || 0,
            assetReferences: Number(character?.sourceInfo?.assetReferenceCount) || 0,
            realmId: realmId(character),
        }));

    const output = {
        databaseBytes: raw.length,
        characters: characters.length,
        sourceCounts: Object.fromEntries([...sourceCounts].sort((a, b) => b[1].total - a[1].total)),
        matchingFolders: folders.filter((folder) => /mobile|모바일|proton|프로톤/i.test(folder.name)),
        targetSummary: {
            total: targets.length,
            missing: targets.filter((target) => target.missing > 0).length,
            exactRealm: targets.filter((target) => target.realmId).length,
            missingWithExactRealm: targets.filter((target) => target.missing > 0 && target.realmId).length,
            missingWithoutExactRealm: targets.filter((target) => target.missing > 0 && !target.realmId).length,
        },
        targets: process.argv.includes('--summary')
            ? targets.filter((target) => target.missing > 0 && target.realmId)
            : process.argv.includes('--full')
                ? targets
                : targets.filter((target) => target.missing > 0),
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    sqlite.close();
})().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});
