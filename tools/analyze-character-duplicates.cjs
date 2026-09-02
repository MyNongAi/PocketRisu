'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { decodeRisuSave } = require('../server/node/utils.cjs');

const dbPath = process.argv[2];
if (!dbPath) {
    throw new Error('Usage: node tools/analyze-character-duplicates.cjs <risuai.db>');
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
}

function keyOf(value) {
    return JSON.stringify(stable(value));
}

function loreText(lore) {
    return (Array.isArray(lore) ? lore : []).map((entry) => (
        typeof entry?.content === 'string' ? entry.content : ''
    ));
}

function summarizeGroups(characters, makeKey) {
    const groups = new Map();
    characters.forEach((character, index) => {
        const key = makeKey(character);
        const group = groups.get(key) ?? [];
        group.push({
            index,
            id: character?.chaId ?? null,
            name: character?.name ?? '',
            source: character?.sourceInfo?.label ?? null,
        });
        groups.set(key, group);
    });
    const duplicates = [...groups.values()]
        .filter((group) => group.length > 1)
        .sort((a, b) => b.length - a.length || a[0].name.localeCompare(b[0].name));
    const removable = duplicates.reduce((sum, group) => sum + group.length - 1, 0);
    return {
        groupCount: duplicates.length,
        rowsInDuplicateGroups: duplicates.reduce((sum, group) => sum + group.length, 0),
        removable,
        remaining: characters.length - removable,
        ...(process.argv.includes('--summary') ? {} : { largestGroups: duplicates.slice(0, 20) }),
    };
}

const sqlite = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });
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

(async () => {
    const raw = readValue('database/database.bin');
    if (!raw) throw new Error('database/database.bin is missing');
    const decoded = await decodeRisuSave(raw);
    const characters = Array.isArray(decoded?.characters) ? decoded.characters : [];
    const namedCharacters = characters.filter((character) => (character?.name ?? '') !== '');
    const result = {
        totalCharacters: characters.length,
        namedCharacters: namedCharacters.length,
        definitions: {
            exactNameAndLoreText: 'Exact character name and ordered globalLore[].content strings',
            exactNameAndFullLore: 'Exact character name and every globalLore field/value (object key order ignored)',
            exactNameOnly: 'Exact character name only',
        },
        exactNameAndLoreText: summarizeGroups(characters, (character) => keyOf([
            character?.name ?? '',
            loreText(character?.globalLore),
        ])),
        exactNameAndFullLore: summarizeGroups(characters, (character) => keyOf([
            character?.name ?? '',
            Array.isArray(character?.globalLore) ? character.globalLore : [],
        ])),
        exactNameOnly: summarizeGroups(characters, (character) => keyOf(character?.name ?? '')),
        namedExactNameAndLoreText: summarizeGroups(namedCharacters, (character) => keyOf([
            character?.name ?? '',
            loreText(character?.globalLore),
        ])),
        namedExactNameAndFullLore: summarizeGroups(namedCharacters, (character) => keyOf([
            character?.name ?? '',
            Array.isArray(character?.globalLore) ? character.globalLore : [],
        ])),
    };
    process.stdout.write(JSON.stringify(result, null, 2));
    sqlite.close();
})().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});
