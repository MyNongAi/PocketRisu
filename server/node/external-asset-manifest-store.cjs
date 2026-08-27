'use strict';

const { parseExternalAssetUri } = require('./external-assets.cjs');

const DEFAULT_MANIFEST_KEY = 'external-assets/manifest.v1.json';
const DEFAULT_LEGACY_ARCHIVE_KEY = 'external-assets/manifest.v1.legacy.json';
const MANIFEST_VERSION = 1;

function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertManifest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.version !== MANIFEST_VERSION || !value.assets
        || typeof value.assets !== 'object' || Array.isArray(value.assets)) {
        throw new Error('Invalid or unsupported external asset manifest structure');
    }
    return value;
}

function decodeManifestBuffer(raw) {
    if (!raw) return null;
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch (error) {
        throw new Error(`Invalid external asset manifest JSON: ${error?.message || error}`);
    }
    return assertManifest(parsed);
}

function createSqliteManifestStore(options = {}) {
    const db = options.db;
    if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
        throw new TypeError('A better-sqlite3 compatible db is required');
    }
    const key = options.key || DEFAULT_MANIFEST_KEY;
    const archiveKey = options.archiveKey || DEFAULT_LEGACY_ARCHIVE_KEY;
    const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();

    db.exec(`
        CREATE TABLE IF NOT EXISTS external_asset_manifest_meta (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            version INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS external_asset_manifest_entries (
            uri TEXT PRIMARY KEY,
            provider_id TEXT NOT NULL,
            hash TEXT NOT NULL,
            size INTEGER,
            status TEXT,
            last_verified_at TEXT,
            has_fallback INTEGER NOT NULL DEFAULT 0,
            entry_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS external_asset_manifest_fallbacks (
            uri TEXT NOT NULL,
            internal_key TEXT NOT NULL,
            PRIMARY KEY (uri, internal_key)
        );
        CREATE TABLE IF NOT EXISTS external_asset_manifest_migrations (
            uri TEXT NOT NULL,
            migration_id TEXT NOT NULL,
            PRIMARY KEY (uri, migration_id)
        );
        CREATE INDEX IF NOT EXISTS idx_external_asset_manifest_provider
            ON external_asset_manifest_entries(provider_id);
        CREATE INDEX IF NOT EXISTS idx_external_asset_manifest_status
            ON external_asset_manifest_entries(status, last_verified_at);
        CREATE INDEX IF NOT EXISTS idx_external_asset_manifest_fallback_key
            ON external_asset_manifest_fallbacks(internal_key, uri);
        CREATE INDEX IF NOT EXISTS idx_external_asset_manifest_migration
            ON external_asset_manifest_migrations(migration_id, uri);
    `);

    const selectMeta = db.prepare('SELECT version, created_at, updated_at FROM external_asset_manifest_meta WHERE singleton = 1');
    const insertMeta = db.prepare(`
        INSERT INTO external_asset_manifest_meta (singleton, version, created_at, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at
    `);
    const selectEntry = db.prepare('SELECT entry_json FROM external_asset_manifest_entries WHERE uri = ?');
    const selectEntries = db.prepare('SELECT entry_json FROM external_asset_manifest_entries ORDER BY uri');
    const selectCount = db.prepare('SELECT COUNT(*) AS count FROM external_asset_manifest_entries');
    const selectStats = db.prepare(`
        SELECT COUNT(*) AS count,
               COALESCE(SUM(CASE WHEN size >= 0 THEN size ELSE 0 END), 0) AS bytes,
               COALESCE(SUM(CASE WHEN status = 'verified' AND last_verified_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS verified,
               COALESCE(SUM(has_fallback), 0) AS fallback
        FROM external_asset_manifest_entries
    `);
    const selectProviderIds = db.prepare('SELECT DISTINCT provider_id FROM external_asset_manifest_entries ORDER BY provider_id');
    const selectMigrationIds = db.prepare('SELECT DISTINCT migration_id FROM external_asset_manifest_migrations ORDER BY migration_id');
    const selectByInternalKey = db.prepare(`
        SELECT e.entry_json
        FROM external_asset_manifest_fallbacks f
        JOIN external_asset_manifest_entries e ON e.uri = f.uri
        WHERE f.internal_key = ?
        ORDER BY e.uri
        LIMIT 1
    `);
    const upsertEntry = db.prepare(`
        INSERT INTO external_asset_manifest_entries (
            uri, provider_id, hash, size, status, last_verified_at, has_fallback, entry_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uri) DO UPDATE SET
            provider_id = excluded.provider_id,
            hash = excluded.hash,
            size = excluded.size,
            status = excluded.status,
            last_verified_at = excluded.last_verified_at,
            has_fallback = excluded.has_fallback,
            entry_json = excluded.entry_json
    `);
    const deleteEntry = db.prepare('DELETE FROM external_asset_manifest_entries WHERE uri = ?');
    const deleteFallbacks = db.prepare('DELETE FROM external_asset_manifest_fallbacks WHERE uri = ?');
    const insertFallback = db.prepare('INSERT OR IGNORE INTO external_asset_manifest_fallbacks (uri, internal_key) VALUES (?, ?)');
    const deleteMigrations = db.prepare('DELETE FROM external_asset_manifest_migrations WHERE uri = ?');
    const insertMigration = db.prepare('INSERT OR IGNORE INTO external_asset_manifest_migrations (uri, migration_id) VALUES (?, ?)');
    const clearEntries = db.prepare('DELETE FROM external_asset_manifest_entries');
    const clearFallbacks = db.prepare('DELETE FROM external_asset_manifest_fallbacks');
    const clearMigrations = db.prepare('DELETE FROM external_asset_manifest_migrations');
    const clearMeta = db.prepare('DELETE FROM external_asset_manifest_meta');

    function normalizeEntry(uri, value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('External asset manifest entries must be objects');
        }
        const parsed = parseExternalAssetUri(uri);
        const canonical = parsed.uri;
        const copy = { ...cloneJson(value), uri: canonical };
        if (copy.providerId !== undefined && copy.providerId !== parsed.providerId) {
            throw new Error(`External asset manifest provider mismatch: ${canonical}`);
        }
        if (copy.hash !== undefined && copy.hash !== parsed.hash) {
            throw new Error(`External asset manifest hash mismatch: ${canonical}`);
        }
        copy.providerId = parsed.providerId;
        copy.hash = parsed.hash;
        if (copy.size !== undefined && (!Number.isSafeInteger(copy.size) || copy.size < 0)) {
            throw new Error(`External asset manifest has invalid size: ${canonical}`);
        }
        return copy;
    }

    function migrationIds(entry) {
        return [...new Set([
            ...(Array.isArray(entry.migrationIds) ? entry.migrationIds : []),
            ...(typeof entry.migrationId === 'string' ? [entry.migrationId] : []),
        ].filter((value) => typeof value === 'string' && value))];
    }

    function writeNormalizedEntry(entry) {
        const fallbacks = Array.isArray(entry.fallbacks) ? entry.fallbacks : [];
        upsertEntry.run(
            entry.uri,
            entry.providerId,
            entry.hash,
            Number.isSafeInteger(entry.size) ? entry.size : null,
            typeof entry.status === 'string' ? entry.status : null,
            typeof entry.lastVerifiedAt === 'string' ? entry.lastVerifiedAt : null,
            fallbacks.length > 0 ? 1 : 0,
            JSON.stringify(entry),
        );
        deleteFallbacks.run(entry.uri);
        for (const fallback of fallbacks) {
            if (typeof fallback?.internalKey === 'string' && fallback.internalKey) {
                insertFallback.run(entry.uri, fallback.internalKey);
            }
        }
        deleteMigrations.run(entry.uri);
        for (const migrationId of migrationIds(entry)) insertMigration.run(entry.uri, migrationId);
    }

    function currentMeta() {
        const row = selectMeta.get();
        if (row) return { version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
        const timestamp = now();
        return { version: MANIFEST_VERSION, createdAt: timestamp, updatedAt: timestamp };
    }

    const replaceManifestTransaction = db.transaction((manifest) => {
        const checked = assertManifest(manifest);
        clearFallbacks.run();
        clearMigrations.run();
        clearEntries.run();
        const createdAt = typeof checked.createdAt === 'string' ? checked.createdAt : now();
        const updatedAt = typeof checked.updatedAt === 'string' ? checked.updatedAt : createdAt;
        clearMeta.run();
        insertMeta.run(MANIFEST_VERSION, createdAt, updatedAt);
        let count = 0;
        for (const [uri, value] of Object.entries(checked.assets)) {
            writeNormalizedEntry(normalizeEntry(uri, value));
            count++;
        }
        return count;
    });

    function replaceManifestSync(manifest) {
        return replaceManifestTransaction(manifest);
    }

    const clearTransaction = db.transaction(() => {
        clearFallbacks.run();
        clearMigrations.run();
        clearEntries.run();
        clearMeta.run();
        const timestamp = now();
        insertMeta.run(MANIFEST_VERSION, timestamp, timestamp);
    });

    function clearSync() {
        clearTransaction();
    }

    const upsertValuesTransaction = db.transaction((values, timestamp, returnEntries) => {
        const results = [];
        for (const { uri, value } of values) {
            const entry = normalizeEntry(uri, value);
            writeNormalizedEntry(entry);
            if (returnEntries) results.push(entry);
        }
        const meta = currentMeta();
        insertMeta.run(MANIFEST_VERSION, meta.createdAt, timestamp);
        return results;
    });

    function upsertManyValuesSync(values, options = {}) {
        if (!Array.isArray(values)) throw new TypeError('Manifest batch values must be an array');
        if (values.length === 0) return [];
        const returnEntries = options.returnEntries !== false;
        return upsertValuesTransaction(values, now(), returnEntries).map(cloneJson);
    }

    function getSync(uri) {
        const canonical = parseExternalAssetUri(uri).uri;
        const row = selectEntry.get(canonical);
        return row ? cloneJson(JSON.parse(row.entry_json)) : null;
    }

    function getManySync(uris) {
        if (!Array.isArray(uris)) throw new TypeError('Manifest URI list must be an array');
        const result = [];
        for (const uri of uris) {
            const entry = getSync(uri);
            if (entry) result.push(entry);
        }
        return result;
    }

    function listSync() {
        return selectEntries.all().map((row) => cloneJson(JSON.parse(row.entry_json)));
    }

    function loadSync() {
        const meta = currentMeta();
        const assets = {};
        for (const entry of listSync()) assets[entry.uri] = entry;
        return { version: MANIFEST_VERSION, createdAt: meta.createdAt, updatedAt: meta.updatedAt, assets };
    }

    function exportBufferSync() {
        return Buffer.from(JSON.stringify(loadSync()), 'utf8');
    }

    function exportByteLengthSync() {
        const meta = currentMeta();
        const prefix = `{"version":${MANIFEST_VERSION},"createdAt":${JSON.stringify(meta.createdAt)},"updatedAt":${JSON.stringify(meta.updatedAt)},"assets":{`;
        let bytes = Buffer.byteLength(prefix) + 2; // closing object + document braces
        let first = true;
        for (const row of db.prepare('SELECT uri, entry_json FROM external_asset_manifest_entries ORDER BY uri').iterate()) {
            if (!first) bytes += 1;
            first = false;
            bytes += Buffer.byteLength(JSON.stringify(row.uri)) + 1 + Buffer.byteLength(row.entry_json);
        }
        return bytes;
    }

    function statsSync() {
        const row = selectStats.get();
        return {
            count: Number(row.count) || 0,
            bytes: Number(row.bytes) || 0,
            verified: Number(row.verified) || 0,
            fallback: Number(row.fallback) || 0,
            providerIds: selectProviderIds.all().map((value) => value.provider_id),
            migrationIds: selectMigrationIds.all().map((value) => value.migration_id),
        };
    }

    function findByInternalKeySync(internalKey) {
        const row = selectByInternalKey.get(internalKey);
        return row ? cloneJson(JSON.parse(row.entry_json)) : null;
    }

    function removeSync(uri) {
        const canonical = parseExternalAssetUri(uri).uri;
        return db.transaction(() => {
            deleteFallbacks.run(canonical);
            deleteMigrations.run(canonical);
            const changed = deleteEntry.run(canonical).changes > 0;
            if (changed) {
                const meta = currentMeta();
                insertMeta.run(MANIFEST_VERSION, meta.createdAt, now());
            }
            return changed;
        })();
    }

    // One-time, lossless migration from the old monolithic KV JSON. The exact
    // bytes are retained under an archive key, while the active key is removed
    // so future reads cannot accidentally fall back to the stale giant blob.
    const legacyRow = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    const existingCount = Number(selectCount.get().count) || 0;
    if (legacyRow) {
        const legacyManifest = decodeManifestBuffer(legacyRow.value);
        db.transaction(() => {
            if (existingCount === 0) replaceManifestSync(legacyManifest);
            db.prepare(`
                INSERT OR REPLACE INTO kv (key, value, updated_at)
                SELECT ?, value, updated_at FROM kv WHERE key = ?
            `).run(archiveKey, key);
            db.prepare('DELETE FROM kv WHERE key = ?').run(key);
        })();
    } else if (!selectMeta.get()) {
        clearSync();
    }

    let tail = Promise.resolve();
    function serialized(operation) {
        const result = tail.then(operation, operation);
        tail = result.then(() => undefined, () => undefined);
        return result;
    }

    async function upsertMany(updates) {
        if (!Array.isArray(updates)) throw new TypeError('Manifest batch updates must be an array');
        if (updates.length === 0) return [];
        return serialized(async () => {
            const values = [];
            for (const update of updates) {
                if (!update || typeof update !== 'object') throw new TypeError('Each manifest batch update must be an object');
                const canonical = parseExternalAssetUri(update.uri).uri;
                const oldValue = getSync(canonical);
                const nextValue = typeof update.updater === 'function'
                    ? await update.updater(oldValue)
                    : update.value ?? update.updater;
                values.push({ uri: canonical, value: nextValue });
            }
            return upsertManyValuesSync(values);
        });
    }

    return {
        key,
        archiveKey,
        load: async () => loadSync(),
        loadSync,
        exportBufferSync,
        exportByteLengthSync,
        replaceManifest: async (manifest) => replaceManifestSync(manifest),
        replaceManifestSync,
        clear: async () => clearSync(),
        clearSync,
        get: async (uri) => getSync(uri),
        getSync,
        getMany: async (uris) => getManySync(uris),
        getManySync,
        list: async () => listSync(),
        listSync,
        stats: async () => statsSync(),
        statsSync,
        findByInternalKey: async (internalKey) => findByInternalKeySync(internalKey),
        findByInternalKeySync,
        upsert(uri, updater) {
            return upsertMany([{ uri, updater }]).then((entries) => entries[0]);
        },
        upsertMany,
        upsertManyValuesSync,
        remove(uri) {
            return serialized(async () => removeSync(uri));
        },
        removeSync,
    };
}

module.exports = {
    DEFAULT_MANIFEST_KEY,
    DEFAULT_LEGACY_ARCHIVE_KEY,
    MANIFEST_VERSION,
    assertManifest,
    decodeManifestBuffer,
    createSqliteManifestStore,
};
