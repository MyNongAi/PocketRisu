'use strict';

// Read-only audit. There is deliberately no --apply option: removing one of
// two independently enabled modules can change prompt/trigger execution.
const crypto = require('node:crypto');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const HEADER = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]);
const COPY_FIELDS = new Set(['id', 'folderId', 'sourceInfo']);
const DISPLAY_ROOT_FIELDS = new Set(['moduleFolders', 'moduleActivationHistory']);

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function requireBytes(data, start, length) {
    if (!Number.isSafeInteger(length) || length < 0 || start < 0 || start + length > data.length) {
        throw new Error('Truncated or invalid MessagePack value');
    }
}

// Find encoded value boundaries without decoding the 500+ MB character/chat
// document. Buffer.subarray views share the one input buffer.
function skipValue(data, start, depth = 0) {
    requireBytes(data, start, 1);
    if (depth > 256) throw new Error('MessagePack nesting exceeds audit limit');
    const tag = data[start];
    let offset = start + 1;
    let children = 0;
    let bytes = 0;
    if (tag <= 0x7f || tag >= 0xe0 || [0xc0, 0xc2, 0xc3].includes(tag)) return offset;
    if ((tag & 0xe0) === 0xa0) bytes = tag & 0x1f;
    else if ((tag & 0xf0) === 0x90) children = tag & 0xf;
    else if ((tag & 0xf0) === 0x80) children = (tag & 0xf) * 2;
    else {
        const sizes = { 0xca: 4, 0xcb: 8, 0xcc: 1, 0xcd: 2, 0xce: 4, 0xcf: 8,
            0xd0: 1, 0xd1: 2, 0xd2: 4, 0xd3: 8,
            0xd4: 2, 0xd5: 3, 0xd6: 5, 0xd7: 9, 0xd8: 17 };
        if (sizes[tag]) bytes = sizes[tag];
        else if ([0xc4, 0xc7, 0xd9].includes(tag)) {
            requireBytes(data, offset, 1); bytes = data[offset++];
            if (tag === 0xc7) bytes++;
        } else if ([0xc5, 0xc8, 0xda].includes(tag)) {
            requireBytes(data, offset, 2); bytes = data.readUInt16BE(offset); offset += 2;
            if (tag === 0xc8) bytes++;
        } else if ([0xc6, 0xc9, 0xdb].includes(tag)) {
            requireBytes(data, offset, 4); bytes = data.readUInt32BE(offset); offset += 4;
            if (tag === 0xc9) bytes++;
        } else if ([0xdc, 0xde].includes(tag)) {
            requireBytes(data, offset, 2); children = data.readUInt16BE(offset); offset += 2;
            if (tag === 0xde) children *= 2;
        } else if ([0xdd, 0xdf].includes(tag)) {
            requireBytes(data, offset, 4); children = data.readUInt32BE(offset); offset += 4;
            if (tag === 0xdf) children *= 2;
        } else throw new Error(`Unsupported MessagePack tag ${tag}`);
    }
    requireBytes(data, offset, bytes);
    offset += bytes;
    if (children > data.length - offset) throw new Error('Invalid MessagePack collection length');
    for (let i = 0; i < children; i++) offset = skipValue(data, offset, depth + 1);
    return offset;
}

function collectionHeader(data, start, kind) {
    requireBytes(data, start, 1);
    const tag = data[start];
    const mask = kind === 'map' ? 0x80 : 0x90;
    if ((tag & 0xf0) === mask) return { count: tag & 0xf, offset: start + 1 };
    if (tag === (kind === 'map' ? 0xde : 0xdc)) {
        requireBytes(data, start + 1, 2);
        return { count: data.readUInt16BE(start + 1), offset: start + 3 };
    }
    if (tag === (kind === 'map' ? 0xdf : 0xdd)) {
        requireBytes(data, start + 1, 4);
        return { count: data.readUInt32BE(start + 1), offset: start + 5 };
    }
    throw new Error(`Expected MessagePack ${kind}`);
}

function mapFields(data, start, decode) {
    const header = collectionHeader(data, start, 'map');
    const result = new Map();
    let offset = header.offset;
    for (let i = 0; i < header.count; i++) {
        const keyEnd = skipValue(data, offset);
        const key = decode(data.subarray(offset, keyEnd));
        if (typeof key !== 'string' || result.has(key)) throw new Error('Invalid or duplicate map key');
        offset = keyEnd;
        const end = skipValue(data, offset);
        result.set(key, { start: offset, end });
        offset = end;
    }
    return { fields: result, end: offset };
}

function stable(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(stable);
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    }
    throw new Error('Non-JSON module field cannot be compared safely');
}

function signatureFor(module, loadManifest) {
    if (!module || typeof module !== 'object' || Array.isArray(module)) throw new Error('Invalid module');
    const definition = Object.fromEntries(Object.entries(module).filter(([key]) => !COPY_FIELDS.has(key)));
    if (module.assetManifest) {
        if (!loadManifest) throw new Error('Asset manifest not verified');
        const items = loadManifest(module.assetManifest, module.id);
        if (!Array.isArray(items)) throw new Error('Manifest loader did not return assets');
        // A stale inline array must not be silently ignored.
        if (Array.isArray(module.assets) && JSON.stringify(module.assets) !== JSON.stringify(items)) {
            throw new Error('Inline assets disagree with verified manifest');
        }
        definition.assets = items;
        delete definition.assetManifest;
    }
    return JSON.stringify(stable(definition));
}

function loadVerifiedManifest(sqlite, descriptor, ownerId) {
    if (!descriptor || typeof descriptor.id !== 'string') throw new Error('Invalid asset manifest descriptor');
    const row = sqlite.prepare('SELECT * FROM asset_manifests WHERE manifest_id = ?').get(descriptor.id);
    if (!row || row.format_version !== 1 || row.owner_kind !== 'module' || row.owner_id !== ownerId) {
        throw new Error('Asset manifest owner/version mismatch');
    }
    const raw = zlib.inflateRawSync(row.payload, { maxOutputLength: 128 * 1024 * 1024 });
    if (digest(raw) !== row.content_hash || raw.length !== row.raw_bytes
        || digest(`module\0${ownerId}\0${row.content_hash}`) !== row.manifest_id) {
        throw new Error('Asset manifest integrity mismatch');
    }
    const items = JSON.parse(raw.toString('utf8'));
    if (!Array.isArray(items) || items.length !== row.item_count
        || (descriptor.count !== undefined && descriptor.count !== row.item_count)
        || (descriptor.sha256 && descriptor.sha256 !== row.content_hash)
        || (descriptor.version !== undefined && descriptor.version !== row.format_version)
        || (descriptor.ownerKind && descriptor.ownerKind !== 'module')
        || (descriptor.ownerId && descriptor.ownerId !== ownerId)) throw new Error('Asset manifest metadata mismatch');
    for (const tuple of items) {
        if (!Array.isArray(tuple) || tuple.length < 2 || tuple.length > 3
            || typeof tuple[0] !== 'string' || typeof tuple[1] !== 'string'
            || (tuple.length === 3 && tuple[2] !== null && typeof tuple[2] !== 'string')) {
            throw new Error('Invalid asset tuple');
        }
    }
    return items;
}

function auditBuffer(data, decode, options = {}) {
    if (!data.subarray(0, HEADER.length).equals(HEADER)) {
        throw new Error('Read-only audit supports raw legacy RisuSave v7 only; do not convert the live DB for this audit');
    }
    const root = mapFields(data, HEADER.length, decode);
    if (root.end !== data.length) throw new Error('Unexpected bytes after database object');
    const field = root.fields.get('modules');
    if (!field) return { totalModules: 0, exactGroups: 0, duplicateCopies: 0, groups: [], skipped: [] };
    const header = collectionHeader(data, field.start, 'array');
    const ignoredSpans = [...root.fields].filter(([key]) => DISPLAY_ROOT_FIELDS.has(key)).map(([, span]) => span);
    const entries = [];
    const skipped = [];
    let offset = header.offset;
    for (let index = 0; index < header.count; index++) {
        const end = skipValue(data, offset);
        try {
            const module = decode(data.subarray(offset, end));
            if (typeof module?.id !== 'string' || module.id.length < 8) throw new Error('Missing or ambiguous module identity');
            const fields = mapFields(data, offset, decode).fields;
            ignoredSpans.push(fields.get('id'));
            const signature = signatureFor(module, options.loadManifest);
            entries.push({ index, id: module.id, signature, hash: digest(signature) });
        } catch (error) { skipped.push({ index, reason: String(error.message) }); }
        offset = end;
    }
    if (offset !== field.end) throw new Error('Invalid modules array boundary');
    const idCounts = new Map();
    for (const entry of entries) idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
    const buckets = new Map();
    for (const entry of entries) {
        const bucket = buckets.get(entry.hash) ?? [];
        bucket.push(entry);
        buckets.set(entry.hash, bucket);
    }
    const groups = [];
    for (const bucket of buckets.values()) {
        // Hash is only an index; equality is still checked on the full string.
        const exact = new Map();
        for (const entry of bucket) {
            const same = exact.get(entry.signature) ?? [];
            same.push(entry); exact.set(entry.signature, same);
        }
        for (const same of exact.values()) {
            if (same.length < 2) continue;
            const members = same.map(entry => {
                const needle = Buffer.from(entry.id);
                let cursor = 0;
                let directReferences = 0;
                while ((cursor = data.indexOf(needle, cursor)) !== -1) {
                    if (!ignoredSpans.some(span => span && cursor >= span.start && cursor + needle.length <= span.end)) directReferences++;
                    cursor += needle.length;
                }
                return { index: entry.index, id: entry.id, directReferences,
                    ambiguousIdentity: idCounts.get(entry.id) !== 1 };
            });
            groups.push({ definitionHash: same[0].hash, copies: same.length, members,
                requiresReview: members.some(member => member.directReferences > 0 || member.ambiguousIdentity) });
        }
    }
    return { totalModules: header.count, comparedModules: entries.length, exactGroups: groups.length,
        duplicateCopies: groups.reduce((sum, group) => sum + group.copies - 1, 0),
        groupsWithDirectReferences: groups.filter(group => group.requiresReview).length,
        groups, skipped };
}

function readChunkedValue(sqlite, key) {
    const row = sqlite.prepare('SELECT value FROM kv WHERE key=?').get(key);
    if (!row) return null;
    // A raw overwrite may leave old manifest rows until cleanup. Follow the
    // canonical kv marker, never resurrect those stale chunks.
    const marker = Buffer.from('\0RISUCHUNKED\0', 'binary');
    if (!Buffer.isBuffer(row.value) || !row.value.equals(marker)) return row.value;
    const total = sqlite.prepare(`SELECT SUM(length(c.data)) AS bytes FROM manifest_chunks m
        JOIN chunks c ON c.hash=m.hash WHERE m.manifest_key=?`).get(key)?.bytes;
    if (!total) throw new Error('Chunk marker has no complete payload');
    const buffer = Buffer.allocUnsafe(total);
    let offset = 0;
    let expectedSequence = 0;
    for (const row of sqlite.prepare(`SELECT m.seq,m.hash,c.data FROM manifest_chunks m LEFT JOIN chunks c ON c.hash=m.hash
        WHERE m.manifest_key=? ORDER BY m.seq`).iterate(key)) {
        if (row.seq !== expectedSequence++ || !Buffer.isBuffer(row.data) || digest(row.data) !== row.hash) {
            throw new Error('Chunk sequence or integrity check failed');
        }
        row.data.copy(buffer, offset); offset += row.data.length;
    }
    if (offset !== total) throw new Error('Chunk length changed during read snapshot');
    return buffer;
}

function main() {
    const args = process.argv.slice(2);
    if (!args[0] || args.some(arg => arg === '--apply')) throw new Error('Usage: node tools/audit-exact-module-duplicates.cjs <risuai.db> [--runtime-root <repo>] [--details]. Read-only; no apply mode.');
    const runtimeIndex = args.indexOf('--runtime-root');
    const runtimeRoot = runtimeIndex >= 0 ? args[runtimeIndex + 1] : path.resolve(__dirname, '..');
    const runtimeRequire = createRequire(path.join(path.resolve(runtimeRoot), 'package.json'));
    const Database = runtimeRequire('better-sqlite3');
    const { Unpackr } = runtimeRequire('msgpackr');
    const unpackr = new Unpackr({ int64AsType: 'number', useRecords: false });
    const sqlite = new Database(path.resolve(args[0]), { readonly: true, fileMustExist: true });
    sqlite.pragma('query_only = ON');
    sqlite.exec('BEGIN');
    try {
        const raw = readChunkedValue(sqlite, 'database/database.bin');
        if (!raw) throw new Error('database/database.bin is missing');
        const result = auditBuffer(raw, bytes => unpackr.decode(bytes), {
            loadManifest: (descriptor, ownerId) => loadVerifiedManifest(sqlite, descriptor, ownerId),
        });
        const { groups, ...summary } = result;
        process.stdout.write(JSON.stringify({ readOnly: true, databaseBytes: raw.length, databaseSha256: digest(raw),
            excludedCopyFields: [...COPY_FIELDS], comparison: 'All remaining field values, lorebook and ordered asset references must be identical. File bytes are not rehashed.',
            warning: 'Candidate report only. Modules have no native trash. Independent activation, script-computed ids and external/plugin references require review before deletion.',
            ...summary, ...(args.includes('--details') ? { groups } : {}) }, null, 2) + '\n');
    } finally { sqlite.exec('ROLLBACK'); sqlite.close(); }
}

module.exports = { HEADER, skipValue, collectionHeader, mapFields, signatureFor, auditBuffer, loadVerifiedManifest, readChunkedValue };
if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
