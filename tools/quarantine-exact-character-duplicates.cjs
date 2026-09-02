'use strict';

const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const { createChunkStore } = require('../server/node/chunkStore.cjs');
const { decodeRisuSave, encodeRisuSaveLegacy, normalizeJSON } = require('../server/node/utils.cjs');

const dbPath = process.argv[2];
const apply = process.argv.includes('--apply');
if (!dbPath) {
    throw new Error('Usage: node tools/quarantine-exact-character-duplicates.cjs <risuai.db> [--apply]');
}

// These fields identify a local copy or its chat/runtime state rather than the
// character definition. Everything else, including every prompt, lore entry,
// module setting and asset reference, must match byte-for-byte after stable key
// ordering before a character is quarantined.
const COPY_OR_SESSION_FIELDS = new Set([
    'chaId',
    'chats',
    'chatFolders',
    'chatPage',
    'coldstorage',
    'coldStoragedChats',
    'scriptstate',
    'firstMsgIndex',
    'sourceInfo',
    'trashTime',
    'lastInteraction',
    'creation_date',
    'modification_date',
    'imported',
]);

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
}

function signatureFor(character) {
    const definition = {};
    for (const [key, value] of Object.entries(character ?? {})) {
        if (!COPY_OR_SESSION_FIELDS.has(key)) definition[key] = value;
    }
    return JSON.stringify(stable(definition));
}

function isCatalogCharacter(character) {
    return character
        && character.type !== 'group'
        && character.chaId !== '§temp'
        && character.chaId !== '§playground'
        && !character.trashTime;
}

function characterOrderRank(order) {
    const rank = new Map();
    let cursor = 0;
    for (const entry of order ?? []) {
        if (typeof entry === 'string') {
            if (!rank.has(entry)) rank.set(entry, cursor++);
            continue;
        }
        for (const id of entry?.data ?? []) {
            if (!rank.has(id)) rank.set(id, cursor++);
        }
    }
    return rank;
}

function keeperScore(entry, orderRank) {
    const missing = Math.max(0, Number(entry.character?.sourceInfo?.missingAssetCount) || 0);
    const rank = orderRank.get(entry.character.chaId) ?? Number.MAX_SAFE_INTEGER;
    return [missing, rank, entry.index];
}

function compareScore(left, right, orderRank) {
    const a = keeperScore(left, orderRank);
    const b = keeperScore(right, orderRank);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function findExactGroups(dbObject) {
    const characters = Array.isArray(dbObject.characters) ? dbObject.characters : [];
    const orderRank = characterOrderRank(dbObject.characterOrder);
    const byHash = new Map();

    for (let index = 0; index < characters.length; index++) {
        const character = characters[index];
        if (!isCatalogCharacter(character)) continue;
        const signature = signatureFor(character);
        const hash = crypto.createHash('sha256').update(signature).digest('hex');
        const buckets = byHash.get(hash) ?? [];
        let bucket = buckets.find((candidate) => candidate.signature === signature);
        if (!bucket) {
            bucket = { signature, entries: [] };
            buckets.push(bucket);
            byHash.set(hash, buckets);
        }
        bucket.entries.push({ index, character });
    }

    const groups = [];
    for (const buckets of byHash.values()) {
        for (const bucket of buckets) {
            if (bucket.entries.length < 2) continue;
            const entries = [...bucket.entries].sort((left, right) => compareScore(left, right, orderRank));
            groups.push({
                keeper: entries[0],
                duplicates: entries.slice(1),
            });
        }
    }
    groups.sort((left, right) => (
        String(left.keeper.character?.name ?? '').localeCompare(String(right.keeper.character?.name ?? ''))
        || left.keeper.index - right.keeper.index
    ));
    return groups;
}

function removeTrashedIdsFromOrder(order, trashedIds) {
    const next = [];
    for (const entry of order ?? []) {
        if (typeof entry === 'string') {
            if (!trashedIds.has(entry)) next.push(entry);
            continue;
        }
        const data = (entry?.data ?? []).filter((id) => !trashedIds.has(id));
        if (data.length > 0) next.push({ ...entry, data });
    }
    return next;
}

function quarantineExactDuplicates(dbObject, trashTimestamp = Date.now()) {
    const groups = findExactGroups(dbObject);
    const duplicateEntries = groups.flatMap((group) => group.duplicates);
    const trashedIds = new Set();
    const usedIds = new Set((dbObject.characters ?? []).map((character) => character?.chaId).filter(Boolean));

    for (const entry of duplicateEntries) {
        let id = entry.character.chaId;
        // Native trash and characterOrder are id-based. If an imported backup
        // duplicated the same chaId, give only the trashed copy a fresh identity
        // so the healthy keeper remains independently addressable.
        if (!id || trashedIds.has(id) || groups.some((group) => group.keeper.character.chaId === id)) {
            do { id = crypto.randomUUID(); } while (usedIds.has(id));
            entry.character.chaId = id;
            usedIds.add(id);
        }
        entry.character.trashTime = trashTimestamp;
        trashedIds.add(id);
    }
    dbObject.characterOrder = removeTrashedIdsFromOrder(dbObject.characterOrder ?? [], trashedIds);

    return {
        totalCharacters: dbObject.characters?.length ?? 0,
        activeCharacters: (dbObject.characters ?? []).filter((character) => !character?.trashTime).length,
        nativeTrashTotal: (dbObject.characters ?? []).filter((character) => !!character?.trashTime).length,
        exactGroups: groups.length,
        trashed: duplicateEntries.length,
        trashTimestamp,
        examples: groups.slice(0, 30).map((group) => ({
            name: group.keeper.character?.name ?? '',
            copies: group.duplicates.length + 1,
            keptId: group.keeper.character?.chaId ?? null,
            keptMissingAssets: Number(group.keeper.character?.sourceInfo?.missingAssetCount) || 0,
            trashedCopies: group.duplicates.map((entry) => ({
                id: entry.character?.chaId ?? null,
                missingAssets: Number(entry.character?.sourceInfo?.missingAssetCount) || 0,
            })),
        })),
    };
}

(async () => {
    const sqlite = new Database(path.resolve(dbPath), { readonly: !apply, fileMustExist: true });
    const store = apply ? createChunkStore(sqlite) : null;
    const raw = apply
        ? store.getValue('database/database.bin')
        : (() => {
            const chunks = sqlite.prepare(`
                SELECT c.data
                FROM manifest_chunks AS m
                JOIN chunks AS c ON c.hash = m.hash
                WHERE m.manifest_key = ?
                ORDER BY m.seq
            `).all('database/database.bin');
            if (chunks.length > 0) return Buffer.concat(chunks.map((row) => row.data));
            return sqlite.prepare('SELECT value FROM kv WHERE key = ?').get('database/database.bin')?.value ?? null;
        })();
    if (!raw) throw new Error('database/database.bin is missing');
    const decoded = await decodeRisuSave(raw);
    const beforeCount = decoded.characters?.length ?? 0;
    const trashTimestamp = Date.now();
    const result = quarantineExactDuplicates(decoded, trashTimestamp);
    const encoded = Buffer.from(encodeRisuSaveLegacy(normalizeJSON(decoded)));
    const roundTripped = await decodeRisuSave(encoded);
    if ((roundTripped.characters?.length ?? 0) !== beforeCount) {
        throw new Error(`Character count changed: expected ${beforeCount}, got ${roundTripped.characters?.length ?? 0}`);
    }
    const verifiedTrashed = (roundTripped.characters ?? []).filter(
        (character) => character?.trashTime === trashTimestamp,
    ).length;
    if (verifiedTrashed !== result.trashed) {
        throw new Error(`Native trash round-trip failed: expected ${result.trashed}, got ${verifiedTrashed}`);
    }

    let safetyBackupKey = null;
    if (apply && result.trashed > 0) {
        safetyBackupKey = `migration-backup/pre-exact-duplicate-quarantine-${Date.now()}.bin`;
        store.snapshotValue('database/database.bin', safetyBackupKey);
        store.putValue('database/database.bin', encoded);
    }
    process.stdout.write(JSON.stringify({ apply, safetyBackupKey, ...result }, null, 2));
    sqlite.close();
})().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});
