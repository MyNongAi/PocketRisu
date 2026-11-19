'use strict';

// BUILD-FENCE-LATEST-WINS: an older tab keeps saving; only a storage-format break stops it.
// Build ids identify old tabs for one-time logging. The storage epoch fences
// incompatible writes before body parsing. Missing epoch means epoch 1 for
// clients already deployed before this header existed.

const fs = require('fs');

const BUILD_ID_HEADER = 'x-pocketrisu-build';
const STORAGE_EPOCH_HEADER = 'x-pocketrisu-storage-epoch';
const STORAGE_FORMAT_EPOCH = 1;
const BUILD_ID_FILE_NAME = 'build-id.txt';
const STALE_BUILD_STATUS = 426;
const STALE_BUILD_CODE = 'STALE_CLIENT_BUILD';
const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

// POSTs that read or authenticate. Everything else that is not a GET/HEAD
// under /api/ changes server state and is fenced.
const NON_MUTATING_POSTS = new Set([
    '/api/db/boot',
    '/api/assets/bulk-read',
    '/api/assets/inspect',
    '/api/asset-manifests/resolve',
    '/api/session',
    '/api/token/refresh',
    '/api/login',
    '/api/crypto',
    // Persists writes the server already accepted; refusing it saves nothing.
    '/api/db/flush',
    // The reload button restarting the laptop's server: a tab on an older
    // build is the one that most needs it, and it writes no data.
    '/api/laptop/restart',
]);

// GETs that change state.
const MUTATING_GETS = new Set([
    '/api/remove',
]);

function parseBuildId(text) {
    if (typeof text !== 'string') return null;
    const id = text.trim();
    return BUILD_ID_PATTERN.test(id) ? id : null;
}

function normalizePath(requestPath) {
    const raw = String(requestPath || '');
    return (raw.length > 1 ? raw.replace(/\/+$/, '') : raw).toLowerCase();
}

/** Whether a request of this method and path may change server state. */
function isMutatingRequest(method, requestPath) {
    const verb = String(method || '').toUpperCase();
    const p = normalizePath(requestPath);
    if (!p.startsWith('/api/')) return false;
    if (verb === 'GET' || verb === 'HEAD') return MUTATING_GETS.has(p);
    if (verb === 'OPTIONS') return false;
    if (verb === 'POST' && NON_MUTATING_POSTS.has(p)) return false;
    return true;
}

/**
 * The server storage epoch for an incompatible mutating request, or null.
 */
function staleBuildFor({ method, path: requestPath, clientEpoch }) {
    if (!isMutatingRequest(method, requestPath)) return null;
    if (clientEpoch === undefined) return null;
    return String(clientEpoch) === String(STORAGE_FORMAT_EPOCH) ? null : STORAGE_FORMAT_EPOCH;
}

/**
 * Reads dist/build-id.txt, again only after its mtime, ctime or size changed,
 * so a rebuild under a running server is picked up on the next request.
 * Returns null while the file is missing or holds no valid id.
 */
function createBuildIdReader({ file, fsImpl = fs } = {}) {
    let stamp = null;
    let id = null;
    return function currentBuildId() {
        let stat;
        try {
            stat = fsImpl.statSync(file);
        } catch {
            stamp = null;
            id = null;
            return null;
        }
        const next = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
        if (next === stamp) return id;
        stamp = next;
        try {
            id = parseBuildId(fsImpl.readFileSync(file, 'utf-8'));
        } catch {
            id = null;
        }
        return id;
    };
}

function createBuildFence({ readBuildId, logger = console } = {}) {
    // One log line per mismatched client build, not per request.
    const reported = new Set();
    function middleware(req, res, next) {
        const clientBuild = req.headers?.[BUILD_ID_HEADER];
        if (!isMutatingRequest(req.method, req.path)) return next();
        const serverEpoch = staleBuildFor({
            method: req.method,
            path: req.path,
            clientEpoch: req.headers?.[STORAGE_EPOCH_HEADER],
        });
        const safeClientBuild = parseBuildId(clientBuild);
        const serverBuild = safeClientBuild ? readBuildId() : null;
        if (serverBuild && safeClientBuild !== serverBuild && !reported.has(safeClientBuild) && reported.size < 64) {
            reported.add(safeClientBuild);
            logger.warn?.(`[BuildFence] client build ${safeClientBuild} differs from served build ${serverBuild}; writes remain enabled when storage epochs match`);
        }
        if (serverEpoch === null) return next();
        res.status(STALE_BUILD_STATUS).json({
            error: 'This page uses a different storage format. Nothing from this request was saved.',
            code: STALE_BUILD_CODE,
            serverBuild,
            serverEpoch,
        });
    }
    return middleware;
}

module.exports = {
    BUILD_ID_HEADER,
    STORAGE_EPOCH_HEADER,
    STORAGE_FORMAT_EPOCH,
    BUILD_ID_FILE_NAME,
    STALE_BUILD_STATUS,
    STALE_BUILD_CODE,
    parseBuildId,
    isMutatingRequest,
    staleBuildFor,
    createBuildIdReader,
    createBuildFence,
};
