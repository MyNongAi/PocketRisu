'use strict';

// External, content-addressed assets for the Node server.
//
// This module deliberately knows nothing about Risu's database schema. The
// caller supplies the provider configuration, the small manifest's KV
// callbacks, and (optionally) an internal-asset reader. That keeps migrations
// failure-safe: stage() uploads and verifies a copy and writes a trash copy,
// but never rewrites a character/module reference or deletes the original.

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const EXTERNAL_ASSET_SCHEME = 'external://';
const MANIFEST_VERSION = 1;
const DEFAULT_MANIFEST_KEY = 'external-assets/manifest.v1.json';
const SHA256_RE = /^[a-f0-9]{64}$/i;
const PROVIDER_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

class ExternalAssetError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'ExternalAssetError';
        this.code = code;
        this.retryable = options.retryable ?? false;
        if (options.status !== undefined) this.status = options.status;
        if (options.details !== undefined) this.details = options.details;
    }
}

function assertProviderId(providerId) {
    if (
        typeof providerId !== 'string'
        || !PROVIDER_ID_RE.test(providerId)
        || providerId === '.'
        || providerId === '..'
        || providerId.includes('..')
    ) {
        throw new ExternalAssetError(
            'INVALID_PROVIDER_ID',
            'External asset provider IDs must be 1-64 lowercase URL-safe characters.',
        );
    }
    return providerId;
}

function normalizeHash(hash) {
    if (typeof hash !== 'string' || !SHA256_RE.test(hash)) {
        throw new ExternalAssetError('INVALID_ASSET_HASH', 'External asset keys must be SHA-256 hex digests.');
    }
    return hash.toLowerCase();
}

function makeExternalAssetUri(providerId, hash) {
    return `${EXTERNAL_ASSET_SCHEME}${assertProviderId(providerId)}/${normalizeHash(hash)}`;
}

function parseExternalAssetUri(uri) {
    if (typeof uri !== 'string' || !uri.startsWith(EXTERNAL_ASSET_SCHEME)) {
        throw new ExternalAssetError('INVALID_EXTERNAL_URI', 'Expected an external:// asset URI.');
    }
    const rest = uri.slice(EXTERNAL_ASSET_SCHEME.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || rest.indexOf('/', slash + 1) !== -1) {
        throw new ExternalAssetError(
            'INVALID_EXTERNAL_URI',
            'External asset URIs must use external://provider/sha256.',
        );
    }
    const providerId = assertProviderId(rest.slice(0, slash));
    const hash = normalizeHash(rest.slice(slash + 1));
    return { providerId, hash, uri: makeExternalAssetUri(providerId, hash) };
}

function isExternalAssetUri(value) {
    if (typeof value !== 'string' || !value.startsWith(EXTERNAL_ASSET_SCHEME)) return false;
    try {
        parseExternalAssetUri(value);
        return true;
    } catch {
        return false;
    }
}

function toBuffer(value, label = 'asset') {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    throw new ExternalAssetError('INVALID_ASSET_DATA', `${label} must be a Buffer, Uint8Array, or ArrayBuffer.`);
}

function sha256(value) {
    return crypto.createHash('sha256').update(toBuffer(value)).digest('hex');
}

function verifyContent(value, expectedHash, expectedSize) {
    const data = toBuffer(value);
    const actualHash = sha256(data);
    if (actualHash !== normalizeHash(expectedHash)) {
        throw new ExternalAssetError('HASH_MISMATCH', 'External asset SHA-256 verification failed.', {
            details: { expectedHash: normalizeHash(expectedHash), actualHash },
        });
    }
    if (expectedSize !== undefined && expectedSize !== null && data.length !== expectedSize) {
        throw new ExternalAssetError('SIZE_MISMATCH', 'External asset size verification failed.', {
            details: { expectedSize, actualSize: data.length },
        });
    }
    return data;
}

function defaultShouldRetry(error) {
    return !(error instanceof ExternalAssetError) || error.retryable === true;
}

async function withRetry(operation, options = {}) {
    const attempts = Math.max(1, Math.trunc(options.attempts ?? 3));
    const baseDelayMs = Math.max(0, Number(options.baseDelayMs ?? 100));
    const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs ?? 2_000));
    const shouldRetry = options.shouldRetry || defaultShouldRetry;
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await operation(attempt);
        } catch (error) {
            lastError = error;
            if (attempt >= attempts || !shouldRetry(error, attempt)) throw error;
            const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
            const delay = options.jitter === false
                ? exponential
                : Math.round(exponential * (0.75 + Math.random() * 0.5));
            await sleep(delay);
        }
    }
    throw lastError;
}

class ByteLruCache {
    constructor(maxBytes) {
        if (!Number.isFinite(maxBytes) || maxBytes < 0) {
            throw new ExternalAssetError('INVALID_CACHE_SIZE', 'LRU maxBytes must be a non-negative number.');
        }
        this.maxBytes = Math.trunc(maxBytes);
        this.bytes = 0;
        this.entries = new Map();
    }

    get sizeBytes() {
        return this.bytes;
    }

    get size() {
        return this.entries.size;
    }

    has(key) {
        return this.entries.has(key);
    }

    get(key) {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key, value) {
        const data = toBuffer(value, 'cache value');
        this.delete(key);
        if (this.maxBytes === 0 || data.length > this.maxBytes) return false;

        this.entries.set(key, { value: data, size: data.length });
        this.bytes += data.length;
        while (this.bytes > this.maxBytes && this.entries.size > 0) {
            const oldest = this.entries.keys().next().value;
            this.delete(oldest);
        }
        return this.entries.has(key);
    }

    delete(key) {
        const entry = this.entries.get(key);
        if (!entry) return false;
        this.entries.delete(key);
        this.bytes -= entry.size;
        return true;
    }

    clear() {
        this.entries.clear();
        this.bytes = 0;
    }
}

function contentPath(rootDir, hash) {
    const key = normalizeHash(hash);
    return path.join(rootDir, key.slice(0, 2), key);
}

async function atomicWrite(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        await fsp.writeFile(temp, data, { flag: 'wx' });
        await fsp.rename(temp, file);
    } catch (error) {
        await fsp.unlink(temp).catch(() => {});
        throw error;
    }
}

function createFilesystemProvider(options = {}) {
    const id = assertProviderId(options.id);
    if (typeof options.rootDir !== 'string' || options.rootDir.trim() === '') {
        throw new ExternalAssetError('INVALID_PROVIDER_CONFIG', 'Filesystem provider rootDir is required.');
    }
    const rootDir = path.resolve(options.rootDir);

    return {
        id,
        type: 'filesystem',
        capabilities: Object.freeze({ read: true, write: true, stat: true, directUrl: false, androidSaf: false, hardLinkTrash: true }),

        async get(hash) {
            const key = normalizeHash(hash);
            try {
                return await fsp.readFile(contentPath(rootDir, key));
            } catch (error) {
                throw new ExternalAssetError(
                    error && error.code === 'ENOENT' ? 'ASSET_NOT_FOUND' : 'FILESYSTEM_READ_FAILED',
                    `Could not read external asset ${key} from filesystem provider ${id}.`,
                    { cause: error, retryable: error && ['EBUSY', 'EMFILE', 'ENFILE'].includes(error.code) },
                );
            }
        },

        async put(hash, value) {
            const key = normalizeHash(hash);
            const data = verifyContent(value, key);
            const destination = contentPath(rootDir, key);
            try {
                const existing = await fsp.readFile(destination).catch((error) => {
                    if (error && error.code === 'ENOENT') return null;
                    throw error;
                });
                if (existing) {
                    verifyContent(existing, key, data.length);
                    return { hash: key, size: data.length, existed: true };
                }
                try {
                    await atomicWrite(destination, data);
                    return { hash: key, size: data.length, existed: false };
                } catch (writeError) {
                    // Two references may stage the same content concurrently.
                    // On Windows rename() does not replace the winner's file;
                    // accept that race only after verifying the winning bytes.
                    const raced = await fsp.readFile(destination).catch(() => null);
                    if (raced) {
                        verifyContent(raced, key, data.length);
                        return { hash: key, size: data.length, existed: true };
                    }
                    throw writeError;
                }
            } catch (error) {
                if (error instanceof ExternalAssetError) throw error;
                throw new ExternalAssetError('FILESYSTEM_WRITE_FAILED', `Could not write external asset ${key}.`, {
                    cause: error,
                    retryable: error && ['EBUSY', 'EMFILE', 'ENFILE'].includes(error.code),
                });
            }
        },

        async stat(hash) {
            const key = normalizeHash(hash);
            try {
                const info = await fsp.stat(contentPath(rootDir, key));
                return { hash: key, size: info.size, modifiedAt: info.mtimeMs };
            } catch (error) {
                throw new ExternalAssetError(
                    error && error.code === 'ENOENT' ? 'ASSET_NOT_FOUND' : 'FILESYSTEM_STAT_FAILED',
                    `Could not stat external asset ${key}.`,
                    { cause: error, retryable: error && ['EBUSY', 'EMFILE', 'ENFILE'].includes(error.code) },
                );
            }
        },

        // A trash entry on the same filesystem can be another directory entry
        // for the already verified content-addressed file. This preserves an
        // independently deletable recovery path without duplicating tens of GB.
        async linkTo(hash, destination) {
            const key = normalizeHash(hash);
            const source = contentPath(rootDir, key);
            await fsp.mkdir(path.dirname(destination), { recursive: true });
            try {
                await fsp.link(source, destination);
                return true;
            } catch (error) {
                if (error?.code === 'EEXIST') {
                    verifyContent(await fsp.readFile(destination), key);
                    return true;
                }
                if (['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) return false;
                throw new ExternalAssetError('FILESYSTEM_LINK_FAILED', `Could not hard-link external asset ${key} into trash.`, {
                    cause: error,
                    retryable: error && ['EBUSY', 'EMFILE', 'ENFILE'].includes(error.code),
                });
            }
        },
    };
}

function retryableHttpStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

function createHttpProvider(options = {}) {
    const id = assertProviderId(options.id);
    const fetchFn = options.fetch || globalThis.fetch;
    if (typeof fetchFn !== 'function') {
        throw new ExternalAssetError('FETCH_UNAVAILABLE', 'The HTTP provider requires fetch().');
    }
    let baseUrl;
    try {
        baseUrl = new URL(options.baseUrl);
    } catch (error) {
        throw new ExternalAssetError('INVALID_PROVIDER_CONFIG', 'HTTP provider baseUrl must be an absolute URL.', {
            cause: error,
        });
    }
    if (!['http:', 'https:'].includes(baseUrl.protocol)) {
        throw new ExternalAssetError('INVALID_PROVIDER_CONFIG', 'HTTP provider only supports http: and https:.');
    }
    if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
    const maxAssetBytes = options.maxAssetBytes ?? Number.POSITIVE_INFINITY;
    const retryOptions = { attempts: 3, ...options.retry };
    const allowPut = options.allowPut !== false;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
        ? Math.max(1000, Math.floor(Number(options.timeoutMs)))
        : 15_000;

    function urlFor(hash) {
        return new URL(normalizeHash(hash), baseUrl).toString();
    }

    async function resolveHeaders() {
        const source = typeof options.headers === 'function' ? await options.headers() : options.headers;
        return { ...(source || {}) };
    }

    async function request(method, hash, body, metadata = {}, consume = null) {
        const key = normalizeHash(hash);
        return withRetry(async () => {
            const headers = await resolveHeaders();
            if (body) {
                headers['content-type'] = metadata.mimeType || headers['content-type'] || 'application/octet-stream';
                headers['content-length'] = String(body.length);
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetchFn(urlFor(key), { method, headers, body, signal: controller.signal });
                if (!response.ok) {
                    throw new ExternalAssetError('HTTP_STATUS_ERROR', `HTTP ${method} returned ${response.status}.`, {
                        status: response.status,
                        retryable: retryableHttpStatus(response.status),
                    });
                }
                return consume ? await consume(response) : response;
            } catch (error) {
                if (error instanceof ExternalAssetError) throw error;
                throw new ExternalAssetError('HTTP_NETWORK_ERROR', `HTTP ${method} failed for external asset ${key}.`, {
                    cause: error,
                    retryable: true,
                });
            } finally {
                clearTimeout(timer);
            }
        }, retryOptions);
    }

    return {
        id,
        type: 'http',
        managesRetries: true,
        capabilities: Object.freeze({
            read: true,
            write: allowPut,
            stat: true,
            directUrl: options.publicRead === true,
            androidSaf: false,
        }),

        getPublicUrl(hash) {
            if (options.publicRead !== true) return null;
            return urlFor(hash);
        },

        async get(hash) {
            return await request('GET', hash, undefined, {}, async (response) => {
                const declared = Number(response.headers.get('content-length'));
                if (Number.isFinite(declared) && declared > maxAssetBytes) {
                    throw new ExternalAssetError('ASSET_TOO_LARGE', 'Remote asset exceeds maxAssetBytes.');
                }
                const data = Buffer.from(await response.arrayBuffer());
                if (data.length > maxAssetBytes) {
                    throw new ExternalAssetError('ASSET_TOO_LARGE', 'Remote asset exceeds maxAssetBytes.');
                }
                return data;
            });
        },

        async put(hash, value, metadata = {}) {
            if (!allowPut) {
                throw new ExternalAssetError('PROVIDER_READ_ONLY', `HTTP provider ${id} is read-only.`);
            }
            const key = normalizeHash(hash);
            const data = verifyContent(value, key);
            await request('PUT', key, data, metadata);
            return { hash: key, size: data.length };
        },

        async stat(hash) {
            const key = normalizeHash(hash);
            const response = await request('HEAD', key);
            const sizeHeader = response.headers.get('content-length');
            const size = sizeHeader === null ? null : Number(sizeHeader);
            return {
                hash: key,
                size: Number.isFinite(size) ? size : null,
                contentType: response.headers.get('content-type'),
                etag: response.headers.get('etag'),
            };
        },
    };
}

function createAndroidSafProvider(options = {}) {
    const id = assertProviderId(options.id);
    const reason = options.reason
        || 'Android SAF requires a native document-provider bridge; PocketRisu\'s Termux/browser server cannot access it directly.';
    const unsupported = async () => {
        throw new ExternalAssetError('UNSUPPORTED_PROVIDER', reason);
    };
    return {
        id,
        type: 'android-saf',
        capabilities: Object.freeze({
            read: false,
            write: false,
            stat: false,
            directUrl: false,
            androidSaf: false,
            unsupported: true,
            reason,
        }),
        get: unsupported,
        put: unsupported,
        stat: unsupported,
    };
}

function emptyManifest(now) {
    const timestamp = now();
    return { version: MANIFEST_VERSION, createdAt: timestamp, updatedAt: timestamp, assets: {} };
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function decodeManifest(raw, now) {
    if (raw === null || raw === undefined) return emptyManifest(now);
    let parsed = raw;
    if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) parsed = Buffer.from(raw).toString('utf8');
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch (error) {
            throw new ExternalAssetError('INVALID_MANIFEST', 'External asset manifest is not valid JSON.', {
                cause: error,
            });
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ExternalAssetError('INVALID_MANIFEST', 'External asset manifest must be an object.');
    }
    if (parsed.version !== MANIFEST_VERSION) {
        throw new ExternalAssetError(
            'UNSUPPORTED_MANIFEST_VERSION',
            `External asset manifest version ${String(parsed.version)} is not supported.`,
        );
    }
    if (!parsed.assets || typeof parsed.assets !== 'object' || Array.isArray(parsed.assets)) {
        throw new ExternalAssetError('INVALID_MANIFEST', 'External asset manifest assets must be an object.');
    }
    return cloneJson(parsed);
}

function createManifestStore(options = {}) {
    const getValue = options.getValue || options.get;
    const setValue = options.setValue || options.set;
    if (typeof getValue !== 'function' || typeof setValue !== 'function') {
        throw new ExternalAssetError('INVALID_MANIFEST_STORE', 'Manifest store requires get/getValue and set/setValue callbacks.');
    }
    const key = options.key || DEFAULT_MANIFEST_KEY;
    const now = options.now || (() => new Date().toISOString());
    let tail = Promise.resolve();

    async function load() {
        return decodeManifest(await getValue(key), now);
    }

    async function save(manifest) {
        const copy = cloneJson(manifest);
        copy.version = MANIFEST_VERSION;
        copy.updatedAt = now();
        await setValue(key, Buffer.from(JSON.stringify(copy), 'utf8'));
        return copy;
    }

    function serialized(operation) {
        const result = tail.then(operation, operation);
        tail = result.then(() => undefined, () => undefined);
        return result;
    }

    function upsertMany(updates) {
        if (!Array.isArray(updates)) {
            throw new ExternalAssetError('INVALID_MANIFEST_UPDATE', 'Manifest batch updates must be an array.');
        }
        if (updates.length === 0) return Promise.resolve([]);
        return serialized(async () => {
            const manifest = await load();
            const results = [];
            for (const update of updates) {
                if (!update || typeof update !== 'object') {
                    throw new ExternalAssetError('INVALID_MANIFEST_UPDATE', 'Each manifest batch update must be an object.');
                }
                const canonical = parseExternalAssetUri(update.uri).uri;
                const oldValue = manifest.assets[canonical] ? cloneJson(manifest.assets[canonical]) : null;
                const nextValue = typeof update.updater === 'function'
                    ? await update.updater(oldValue)
                    : update.value ?? update.updater;
                if (!nextValue || typeof nextValue !== 'object' || Array.isArray(nextValue)) {
                    throw new ExternalAssetError('INVALID_MANIFEST_ENTRY', 'Manifest entries must be objects.');
                }
                manifest.assets[canonical] = { ...cloneJson(nextValue), uri: canonical };
                results.push(cloneJson(manifest.assets[canonical]));
            }
            await save(manifest);
            return results;
        });
    }

    return {
        key,
        load,
        async get(uri) {
            const canonical = parseExternalAssetUri(uri).uri;
            const manifest = await load();
            return manifest.assets[canonical] ? cloneJson(manifest.assets[canonical]) : null;
        },
        async list() {
            const manifest = await load();
            return Object.values(manifest.assets).map(cloneJson);
        },
        upsert(uri, updater) {
            return upsertMany([{ uri, updater }]).then((entries) => entries[0]);
        },
        upsertMany,
        remove(uri) {
            const canonical = parseExternalAssetUri(uri).uri;
            return serialized(async () => {
                const manifest = await load();
                const existed = Object.prototype.hasOwnProperty.call(manifest.assets, canonical);
                if (existed) {
                    delete manifest.assets[canonical];
                    await save(manifest);
                }
                return existed;
            });
        },
    };
}

function providersToMap(providers) {
    const map = new Map();
    const values = providers instanceof Map
        ? providers.values()
        : Array.isArray(providers)
            ? providers
            : Object.values(providers || {});
    for (const provider of values) {
        if (!provider || typeof provider !== 'object') continue;
        const id = assertProviderId(provider.id);
        if (map.has(id)) throw new ExternalAssetError('DUPLICATE_PROVIDER', `Duplicate external provider ${id}.`);
        map.set(id, provider);
    }
    return map;
}

function resolveInside(rootDir, relativePath) {
    if (typeof relativePath !== 'string' || relativePath === '') {
        throw new ExternalAssetError('INVALID_TRASH_PATH', 'Trash path is missing.');
    }
    const root = path.resolve(rootDir);
    const resolved = path.resolve(root, relativePath);
    const relation = path.relative(root, resolved);
    if (relation.startsWith('..') || path.isAbsolute(relation)) {
        throw new ExternalAssetError('INVALID_TRASH_PATH', 'Trash path escapes the configured trash directory.');
    }
    return resolved;
}

function createExternalAssetService(options = {}) {
    const providers = providersToMap(options.providers);
    const manifest = options.manifestStore;
    if (!manifest || typeof manifest.get !== 'function' || typeof manifest.upsert !== 'function') {
        throw new ExternalAssetError('INVALID_MANIFEST_STORE', 'External asset service requires a manifest store.');
    }
    const trashDir = options.trashDir ? path.resolve(options.trashDir) : null;
    const readInternal = options.readInternal;
    const cache = options.cache || new ByteLruCache(options.cacheMaxBytes ?? 64 * 1024 * 1024);
    const retryOptions = { attempts: 3, ...options.retry };
    const now = options.now || (() => new Date().toISOString());

    async function upsertManifestEntries(updates) {
        if (typeof manifest.upsertMany === 'function') return manifest.upsertMany(updates);
        // Compatibility for callers which supplied a pre-batch custom store.
        const entries = [];
        for (const update of updates) entries.push(await manifest.upsert(update.uri, update.updater));
        return entries;
    }

    function providerFor(providerId, capability) {
        const provider = providers.get(providerId);
        if (!provider) {
            throw new ExternalAssetError('PROVIDER_NOT_FOUND', `External asset provider ${providerId} is not configured.`);
        }
        if (provider.capabilities && provider.capabilities.unsupported) {
            throw new ExternalAssetError('UNSUPPORTED_PROVIDER', provider.capabilities.reason || `${providerId} is unsupported.`);
        }
        if (capability && provider.capabilities && provider.capabilities[capability] !== true) {
            throw new ExternalAssetError('PROVIDER_CAPABILITY_MISSING', `Provider ${providerId} does not support ${capability}.`);
        }
        return provider;
    }

    async function callProvider(provider, operation) {
        if (provider.managesRetries) return operation();
        return withRetry(operation, retryOptions);
    }

    function trashRelativePath(providerId, hash, internalKey) {
        const sourceDigest = crypto.createHash('sha256').update(String(internalKey)).digest('hex').slice(0, 16);
        return path.join(providerId, hash.slice(0, 2), `${hash}-${sourceDigest}.bin`).replace(/\\/g, '/');
    }

    async function writeTrash(provider, providerId, hash, internalKey, data) {
        if (!trashDir) {
            throw new ExternalAssetError('TRASH_UNAVAILABLE', 'A trashDir is required before migration staging.');
        }
        const relativePath = trashRelativePath(providerId, hash, internalKey);
        const destination = resolveInside(trashDir, relativePath);
        if (typeof provider?.linkTo === 'function') {
            const linked = await provider.linkTo(hash, destination);
            if (linked) return relativePath;
        }
        const existing = await fsp.readFile(destination).catch((error) => {
            if (error && error.code === 'ENOENT') return null;
            throw error;
        });
        if (existing) {
            verifyContent(existing, hash, data.length);
        } else {
            try {
                await atomicWrite(destination, data);
            } catch (writeError) {
                const raced = await fsp.readFile(destination).catch(() => null);
                if (!raced) throw writeError;
            }
            verifyContent(await fsp.readFile(destination), hash, data.length);
        }
        return relativePath;
    }

    async function readExternalOnly(parsed, record) {
        const provider = providerFor(parsed.providerId, 'read');
        const data = await callProvider(provider, () => provider.get(parsed.hash));
        return verifyContent(data, parsed.hash, record && record.size);
    }

    async function tryFallbacks(parsed, record) {
        const failures = [];
        for (const fallback of record && Array.isArray(record.fallbacks) ? record.fallbacks : []) {
            if (fallback.trashPath && trashDir) {
                try {
                    const data = await fsp.readFile(resolveInside(trashDir, fallback.trashPath));
                    return { data: verifyContent(data, parsed.hash, record.size), source: 'trash', fallback };
                } catch (error) {
                    failures.push({ source: 'trash', error });
                }
            }
            if (fallback.internalKey && typeof readInternal === 'function') {
                try {
                    const data = await readInternal(fallback.internalKey);
                    if (data !== null && data !== undefined) {
                        return {
                            data: verifyContent(data, parsed.hash, record.size),
                            source: 'internal',
                            fallback,
                        };
                    }
                    throw new ExternalAssetError('ASSET_NOT_FOUND', `Internal fallback ${fallback.internalKey} was not found.`);
                } catch (error) {
                    failures.push({ source: 'internal', error });
                }
            }
        }
        return { data: null, failures };
    }

    async function readWithMeta(uri, readOptions = {}) {
        const parsed = parseExternalAssetUri(uri);
        const cached = readOptions.bypassCache ? undefined : cache.get(parsed.uri);
        if (cached) return { data: cached, source: 'cache', uri: parsed.uri };
        const record = await manifest.get(parsed.uri);
        try {
            const data = await readExternalOnly(parsed, record);
            cache.set(parsed.uri, data);
            return { data, source: 'external', uri: parsed.uri };
        } catch (externalError) {
            if (readOptions.allowFallback === false) throw externalError;
            const fallback = await tryFallbacks(parsed, record);
            if (fallback.data) {
                return {
                    data: fallback.data,
                    source: fallback.source,
                    uri: parsed.uri,
                    externalError,
                    fallback: fallback.fallback,
                };
            }
            throw new ExternalAssetError('EXTERNAL_READ_FAILED', `External asset ${parsed.uri} and all fallbacks failed.`, {
                cause: externalError,
                retryable: externalError.retryable === true,
                details: { fallbackFailures: fallback.failures },
            });
        }
    }

    function stageManifestMetadata(stageOptions) {
        const value = stageOptions.manifestMetadata;
        if (value === undefined) return {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new ExternalAssetError(
                'INVALID_MANIFEST_METADATA',
                'stage manifestMetadata must be an object when provided.',
            );
        }
        return cloneJson(value);
    }

    function requestedMigrationIds(stageOptions, metadata) {
        const values = [];
        const add = (value, label) => {
            if (value === undefined || value === null) return;
            const candidates = Array.isArray(value) ? value : [value];
            for (const candidate of candidates) {
                if (typeof candidate !== 'string' || candidate.trim() === '') {
                    throw new ExternalAssetError('INVALID_MIGRATION_ID', `${label} must contain non-empty strings.`);
                }
                values.push(candidate);
            }
        };
        add(stageOptions.migrationId, 'stage migrationId');
        add(stageOptions.migrationIds, 'stage migrationIds');
        add(metadata.migrationId, 'manifestMetadata.migrationId');
        add(metadata.migrationIds, 'manifestMetadata.migrationIds');
        return [...new Set(values)];
    }

    async function prepareStage(stageOptions = {}) {
        const providerId = assertProviderId(stageOptions.providerId);
        const provider = providerFor(providerId, 'write');
        providerFor(providerId, 'read'); // staging must re-download before publishing a mapping
        const data = toBuffer(stageOptions.data);
        const hash = sha256(data);
        const uri = makeExternalAssetUri(providerId, hash);
        const internalKey = stageOptions.internalKey;
        if (typeof internalKey !== 'string' || internalKey === '') {
            throw new ExternalAssetError('INVALID_INTERNAL_KEY', 'Migration staging requires the original internal asset key.');
        }
        const manifestMetadata = stageManifestMetadata(stageOptions);
        const migrationIds = requestedMigrationIds(stageOptions, manifestMetadata);

        // Safety order is intentional: upload -> re-download verification ->
        // durable trash copy -> manifest. Reference rewrites happen elsewhere.
        await callProvider(provider, () => provider.put(hash, data, { mimeType: stageOptions.mimeType }));
        const downloaded = await callProvider(provider, () => provider.get(hash));
        verifyContent(downloaded, hash, data.length);
        const trashPath = await writeTrash(provider, providerId, hash, internalKey, data);
        const timestamp = now();

        return {
            uri,
            providerId,
            hash,
            size: data.length,
            internalKey,
            trashPath,
            timestamp,
            downloaded,
            mimeType: stageOptions.mimeType,
            assetName: stageOptions.assetName,
            manifestMetadata,
            migrationIds,
        };
    }

    function stagedManifestUpdater(prepared) {
        return (old) => {
            const {
                migrationId: _metadataMigrationId,
                migrationIds: _metadataMigrationIds,
                ...metadata
            } = prepared.manifestMetadata;
            const fallbacks = Array.isArray(old && old.fallbacks) ? old.fallbacks.slice() : [];
            const replacement = {
                internalKey: prepared.internalKey,
                trashPath: prepared.trashPath,
                stagedAt: prepared.timestamp,
            };
            const index = fallbacks.findIndex((item) => item.internalKey === prepared.internalKey);
            if (index >= 0) fallbacks[index] = replacement;
            else fallbacks.push(replacement);
            const oldMigrationIds = [
                ...(Array.isArray(old && old.migrationIds) ? old.migrationIds : []),
                ...(typeof (old && old.migrationId) === 'string' ? [old.migrationId] : []),
            ].filter((value) => typeof value === 'string' && value !== '');
            const migrationIds = [...new Set([...oldMigrationIds, ...prepared.migrationIds])];
            const entry = {
                ...(old || {}),
                ...metadata,
                uri: prepared.uri,
                providerId: prepared.providerId,
                hash: prepared.hash,
                size: prepared.size,
                mimeType: prepared.mimeType || (old && old.mimeType) || 'application/octet-stream',
                assetName: prepared.assetName || (old && old.assetName) || null,
                status: 'staged',
                createdAt: (old && old.createdAt) || prepared.timestamp,
                stagedAt: prepared.timestamp,
                lastVerifiedAt: prepared.timestamp,
                fallbacks,
            };
            if (migrationIds.length > 0) entry.migrationIds = migrationIds;
            return entry;
        };
    }

    async function stage(stageOptions = {}) {
        const prepared = await prepareStage(stageOptions);
        const [published] = await publishStaged([prepared]);
        const entry = published.entry;
        cache.set(prepared.uri, prepared.downloaded);
        return { uri: prepared.uri, hash: prepared.hash, size: prepared.size, entry };
    }

    // Upload, re-download verify, and write the recoverable trash copy without
    // growing the manifest yet. Large resumable migrations persist this small
    // receipt in their SQLite journal and publish every mapping once, together
    // with the final DB reference rewrite. This avoids rewriting a hundreds-of-
    // MB JSON manifest for every small transfer batch.
    async function stageDetached(stageOptions = {}) {
        const { downloaded: _downloaded, ...prepared } = await prepareStage(stageOptions);
        return cloneJson(prepared);
    }

    async function publishStaged(preparedEntries) {
        if (!Array.isArray(preparedEntries)) {
            throw new ExternalAssetError('INVALID_STAGE_BATCH', 'publishStaged requires an array of staged receipts.');
        }
        if (preparedEntries.length === 0) return [];
        const normalized = preparedEntries.map((prepared) => ({
            ...prepared,
            manifestMetadata: prepared?.manifestMetadata || {},
            migrationIds: Array.isArray(prepared?.migrationIds) ? prepared.migrationIds : [],
        }));
        const entries = await upsertManifestEntries(normalized.map((prepared) => ({
            uri: prepared.uri,
            updater: stagedManifestUpdater(prepared),
        })));
        const finalEntries = new Map();
        for (let index = entries.length - 1; index >= 0; index--) {
            if (!finalEntries.has(entries[index].uri)) finalEntries.set(entries[index].uri, entries[index]);
        }
        return normalized.map((prepared) => ({
            uri: prepared.uri,
            hash: prepared.hash,
            size: prepared.size,
            entry: cloneJson(finalEntries.get(prepared.uri)),
        }));
    }

    // The iterable form lets migrations read and release one large internal
    // blob at a time while committing all small manifest mutations in one
    // load/save operation.
    async function stageMany(stageOptionsIterable) {
        const isIterable = stageOptionsIterable
            && (typeof stageOptionsIterable[Symbol.iterator] === 'function'
                || typeof stageOptionsIterable[Symbol.asyncIterator] === 'function');
        if (!isIterable) {
            throw new ExternalAssetError('INVALID_STAGE_BATCH', 'stageMany requires an iterable of stage options.');
        }

        const preparedEntries = [];
        for await (const stageOptions of stageOptionsIterable) {
            const { downloaded: _downloaded, ...prepared } = await prepareStage(stageOptions);
            preparedEntries.push(prepared);
        }
        if (preparedEntries.length === 0) return [];

        return publishStaged(preparedEntries);
    }

    async function verify(uri) {
        const parsed = parseExternalAssetUri(uri);
        const old = await manifest.get(parsed.uri);
        const data = await readExternalOnly(parsed, old);
        const timestamp = now();
        const entry = old
            ? await manifest.upsert(parsed.uri, (current) => ({
                ...current,
                status: 'verified',
                lastVerifiedAt: timestamp,
                size: data.length,
            }))
            : null;
        cache.set(parsed.uri, data);
        return { uri: parsed.uri, hash: parsed.hash, size: data.length, verifiedAt: timestamp, entry };
    }

    async function verifyMany(uris = null) {
        if (typeof manifest.list !== 'function') {
            throw new ExternalAssetError('INVALID_MANIFEST_STORE', 'Batch verification requires a manifest store with list().');
        }
        const records = await manifest.list();
        const recordsByUri = new Map(records.map((record) => [parseExternalAssetUri(record.uri).uri, record]));
        if (uris !== null && uris !== undefined && !Array.isArray(uris)) {
            throw new ExternalAssetError('INVALID_VERIFY_TARGETS', 'verifyMany targets must be an array.');
        }
        const targetUris = uris === null || uris === undefined
            ? [...recordsByUri.keys()]
            : [...new Set(uris.map((uri) => parseExternalAssetUri(uri).uri))];
        const successful = [];
        const results = [];

        for (const uri of targetUris) {
            const parsed = parseExternalAssetUri(uri);
            const record = recordsByUri.get(parsed.uri);
            if (!record) {
                results.push({
                    uri: parsed.uri,
                    ok: false,
                    error: new ExternalAssetError('ASSET_NOT_IN_MANIFEST', `Manifest entry missing for ${parsed.uri}.`),
                });
                continue;
            }
            try {
                const data = await readExternalOnly(parsed, record);
                successful.push({ parsed, data });
                results.push({ uri: parsed.uri, ok: true, hash: parsed.hash, size: data.length });
            } catch (error) {
                results.push({ uri: parsed.uri, ok: false, error });
            }
        }

        if (successful.length > 0) {
            const timestamp = now();
            await upsertManifestEntries(successful.map(({ parsed, data }) => ({
                uri: parsed.uri,
                updater: (current) => ({
                    ...current,
                    status: 'verified',
                    lastVerifiedAt: timestamp,
                    size: data.length,
                }),
            })));
        }
        return results;
    }

    async function purgeTrashMany(uris, purgeOptions = {}) {
        if (purgeOptions.userVerified !== true) {
            throw new ExternalAssetError(
                'USER_VERIFICATION_REQUIRED',
                'Trash can only be purged after explicit user verification.',
            );
        }
        if (!trashDir) throw new ExternalAssetError('TRASH_UNAVAILABLE', 'No trashDir is configured.');

        let targetUris = null;
        if (uris !== null && uris !== undefined) {
            if (!Array.isArray(uris)) {
                throw new ExternalAssetError('INVALID_PURGE_TARGETS', 'purgeTrashMany targets must be an array.');
            }
            targetUris = [...new Set(uris.map((uri) => parseExternalAssetUri(uri).uri))];
        }

        let allRecords;
        if (typeof manifest.list === 'function') {
            allRecords = await manifest.list();
        } else if (targetUris === null) {
            throw new ExternalAssetError(
                'INVALID_MANIFEST_STORE',
                'Purging all trash requires a manifest store with list().',
            );
        } else {
            allRecords = (await Promise.all(targetUris.map((uri) => manifest.get(uri)))).filter(Boolean);
        }
        const recordByUri = new Map();
        for (const record of allRecords) {
            const canonical = parseExternalAssetUri(record && record.uri).uri;
            recordByUri.set(canonical, record);
        }
        const existingRecords = targetUris === null
            ? [...recordByUri.values()]
            : targetUris.map((uri) => recordByUri.get(uri)).filter(Boolean);

        // Preflight every target before deleting anything so a mixed verified /
        // unverified manifest cannot cause a partial destructive purge.
        const filesToDelete = new Map();
        for (const record of existingRecords) {
            if (record.status !== 'verified' || !record.lastVerifiedAt) {
                throw new ExternalAssetError('ASSET_NOT_VERIFIED', `${record.uri} has not passed external verification.`);
            }
            for (const fallback of Array.isArray(record.fallbacks) ? record.fallbacks : []) {
                if (!fallback.trashPath) continue;
                const file = resolveInside(trashDir, fallback.trashPath);
                filesToDelete.set(file, null);
            }
        }

        // Stat every file before the first unlink. This catches malformed paths
        // and ordinary I/O failures without leaving a verified batch half-purged.
        for (const file of filesToDelete.keys()) {
            const info = await fsp.stat(file).catch((error) => {
                if (error && error.code === 'ENOENT') return null;
                throw error;
            });
            filesToDelete.set(file, info);
        }

        let files = 0;
        let bytes = 0;

        for (const [file, info] of filesToDelete) {
            await fsp.unlink(file).catch((error) => {
                if (!error || error.code !== 'ENOENT') throw error;
            });
            if (info) {
                files++;
                bytes += info.size;
            }
        }

        const purgedAt = now();
        await upsertManifestEntries(existingRecords.map((record) => ({
            uri: record.uri,
            updater: (current) => {
                const base = current || record;
                return {
                ...base,
                trashPurgedAt: purgedAt,
                fallbacks: (base.fallbacks || []).map(({ trashPath: _trashPath, ...fallback }) => fallback),
                };
            },
        })));
        return { files, bytes, targets: existingRecords.length };
    }

    async function purgeTrash(uri, purgeOptions = {}) {
        return purgeTrashMany(uri ? [uri] : null, purgeOptions);
    }

    return {
        cache,
        manifest,
        providers,
        stage,
        stageDetached,
        publishStaged,
        stageMany,
        verify,
        verifyMany,
        purgeTrash,
        purgeTrashMany,
        readWithMeta,
        async read(uri, readOptions) {
            return (await readWithMeta(uri, readOptions)).data;
        },
        getPublicUrl(uri) {
            const parsed = parseExternalAssetUri(uri);
            const provider = providerFor(parsed.providerId, 'read');
            if (!provider.capabilities || provider.capabilities.directUrl !== true) return null;
            return provider.getPublicUrl(parsed.hash);
        },
    };
}

module.exports = {
    EXTERNAL_ASSET_SCHEME,
    MANIFEST_VERSION,
    DEFAULT_MANIFEST_KEY,
    ExternalAssetError,
    ByteLruCache,
    isExternalAssetUri,
    makeExternalAssetUri,
    parseExternalAssetUri,
    sha256,
    verifyContent,
    withRetry,
    createFilesystemProvider,
    createHttpProvider,
    createAndroidSafProvider,
    createManifestStore,
    createExternalAssetService,
};
