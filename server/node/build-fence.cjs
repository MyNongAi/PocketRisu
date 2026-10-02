'use strict';

// Stale-build write fence. The server is rebuilt in place (git pull, then a
// vite build into dist/ with emptyOutDir off), and a phone or PC tab left open
// on the previous build keeps saving with the old client code. Every build
// writes its id to dist/build-id.txt and compiles the same id into the client
// (vite.config.ts), which sends it on its storage requests as
// x-pocketrisu-build (src/ts/storage/buildFence.ts). A mutating request whose
// id differs from the dist this server serves is refused with 426 before any
// body parsing or route runs, so nothing of it is applied; the client then
// reloads, or stops saving and keeps its unsaved work on screen.
//
// Fails open: a request without the header (older clients, plugins, tools,
// tests, the vite dev server) or a server without a readable build id is
// handled as before.

const fs = require('fs');

const BUILD_ID_HEADER = 'x-pocketrisu-build';
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
 * The server build id a request must be refused for, or null to let it
 * through: only a mutating request that carries a build id different from a
 * known server build is refused.
 */
function staleBuildFor({ method, path: requestPath, clientBuild, serverBuild }) {
    if (typeof clientBuild !== 'string' || clientBuild === '') return null;
    if (!serverBuild) return null;
    if (clientBuild === serverBuild) return null;
    if (!isMutatingRequest(method, requestPath)) return null;
    return serverBuild;
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
    // One log line per refused client build, not per request.
    const reported = new Set();
    function middleware(req, res, next) {
        const clientBuild = req.headers?.[BUILD_ID_HEADER];
        // Cheap exits first: requests without the header never stat the file.
        if (typeof clientBuild !== 'string' || clientBuild === '') return next();
        if (!isMutatingRequest(req.method, req.path)) return next();
        const serverBuild = staleBuildFor({
            method: req.method,
            path: req.path,
            clientBuild,
            serverBuild: readBuildId(),
        });
        if (!serverBuild) return next();
        if (!reported.has(clientBuild) && reported.size < 64) {
            reported.add(clientBuild);
            logger.warn?.(`[BuildFence] refused ${req.method} ${req.path} from client build ${clientBuild.slice(0, 128)}; serving ${serverBuild}`);
        }
        res.status(STALE_BUILD_STATUS).json({
            error: 'This page runs an older PocketRisu build than the server. Reload it to continue; nothing from this request was saved.',
            code: STALE_BUILD_CODE,
            serverBuild,
        });
    }
    return middleware;
}

module.exports = {
    BUILD_ID_HEADER,
    BUILD_ID_FILE_NAME,
    STALE_BUILD_STATUS,
    STALE_BUILD_CODE,
    parseBuildId,
    isMutatingRequest,
    staleBuildFor,
    createBuildIdReader,
    createBuildFence,
};
