'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MAX_ROWS = 5000;
const MAX_DESCRIPTION_BYTES = 10 * 1024; // 10KB per entry

const saveDir = path.join(process.cwd(), 'save');
if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
}
const dbPath = path.join(saveDir, 'logs.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        level TEXT NOT NULL,
        origin TEXT NOT NULL,
        message TEXT NOT NULL,
        description TEXT,
        source TEXT,
        count INTEGER NOT NULL DEFAULT 1,
        platform TEXT,
        client_id TEXT,
        user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
`);

const stmtInsert = db.prepare(`
    INSERT INTO logs
        (timestamp, level, origin, message, description, source, count, platform, client_id, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtRotate = db.prepare(`
    DELETE FROM logs
    WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)
`);

const stmtClearAll = db.prepare(`DELETE FROM logs`);

const stmtCount = db.prepare(`SELECT COUNT(*) as n FROM logs`);

// ─── Masking ─────────────────────────────────────────────────────────────────
// Sanitize strings before persisting. Order matters: apply specific patterns first.
const MASK_PATTERNS = [
    // JWT (three base64url segments joined by dots, starts with eyJ)
    { re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: '[REDACTED_JWT]' },
    // Bearer tokens
    { re: /Bearer\s+[A-Za-z0-9_.\-+/=]{10,}/gi, replacement: 'Bearer [REDACTED_TOKEN]' },
    // Authorization header values
    { re: /(Authorization\s*[:=]\s*)[^\s,;)}{]+/gi, replacement: '$1[REDACTED_TOKEN]' },
    // Header-style api key fields (x-api-key, api-key, api_key, apikey)
    { re: /((?:x-)?api[-_]?key\s*[:=]\s*)['"]?[^'"\s,;)}{]+/gi, replacement: '$1[REDACTED_API_KEY]' },
    // Anthropic keys (more specific than sk-)
    { re: /sk-ant-[A-Za-z0-9_\-]{20,}/g, replacement: '[REDACTED_API_KEY]' },
    // Google API keys
    { re: /AIza[0-9A-Za-z_\-]{35}/g, replacement: '[REDACTED_API_KEY]' },
    // OpenAI-style keys (catch remaining sk- after Anthropic pattern handled)
    { re: /sk-[A-Za-z0-9_\-]{20,}/g, replacement: '[REDACTED_API_KEY]' },
];

function maskSensitive(value) {
    if (typeof value !== 'string') return value;
    let out = value;
    for (const { re, replacement } of MASK_PATTERNS) {
        out = out.replace(re, replacement);
    }
    return out;
}

function truncate(value, maxBytes) {
    if (typeof value !== 'string') return value;
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
    // crude truncation at byte boundary, then re-encode to avoid broken surrogate
    const buf = Buffer.from(value, 'utf8').subarray(0, maxBytes);
    return buf.toString('utf8') + '...[truncated]';
}

// ─── Insert ──────────────────────────────────────────────────────────────────
function insertEntry(entry) {
    const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : Date.now();
    const level = ['error', 'warning', 'info'].includes(entry.level) ? entry.level : 'info';
    const origin = entry.origin === 'server' ? 'server' : 'client';
    const message = maskSensitive(String(entry.message ?? '')).slice(0, 1000);
    const description = entry.description != null
        ? truncate(maskSensitive(String(entry.description)), MAX_DESCRIPTION_BYTES)
        : null;
    const source = entry.source ? String(entry.source).slice(0, 64) : null;
    const count = Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1;
    const platform = entry.platform ? String(entry.platform).slice(0, 128) : null;
    const clientId = entry.clientId ? String(entry.clientId).slice(0, 64) : null;
    const userAgent = entry.userAgent ? String(entry.userAgent).slice(0, 512) : null;

    stmtInsert.run(timestamp, level, origin, message, description, source, count, platform, clientId, userAgent);
}

const insertMany = db.transaction((entries) => {
    for (const e of entries) insertEntry(e);
});

function addLog(entry) {
    insertMany([entry]);
    maybeRotate();
}

function addLogBatch(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    insertMany(entries);
    maybeRotate();
}

let rotateCounter = 0;
function maybeRotate() {
    // run rotation every 50 inserts to amortize cost
    if (++rotateCounter < 50) return;
    rotateCounter = 0;
    stmtRotate.run(MAX_ROWS);
}

// ─── Server-side logger ──────────────────────────────────────────────────────
const hostname = os.hostname();
const serverPlatform = `Node · ${hostname}`;

function formatArg(arg) {
    if (arg instanceof Error) return arg.stack || arg.message;
    if (arg === null || arg === undefined) return String(arg);
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg); } catch { return String(arg); }
}

function normalizeArgs(args) {
    if (args.length === 0) return { message: '', description: undefined };
    if (args.length === 1) {
        const a = args[0];
        if (a instanceof Error) return { message: a.message || String(a), description: a.stack };
        return { message: formatArg(a), description: undefined };
    }
    const [first, ...rest] = args;
    return {
        message: formatArg(first),
        description: rest.map(formatArg).join(' '),
    };
}

function makeServerLogger() {
    function log(level, args) {
        try {
            const { message, description } = normalizeArgs(args);
            addLog({
                timestamp: Date.now(),
                level,
                origin: 'server',
                message,
                description,
                source: 'server',
                platform: serverPlatform,
            });
        } catch (e) {
            // never let logging crash the caller
            console.error('[logs] failed to persist log entry:', e);
        }
    }
    // varargs-compatible — drop-in for console.error / console.warn
    return {
        error: (...args) => { log('error', args); console.error(...args); },
        warning: (...args) => { log('warning', args); console.warn(...args); },
        warn: (...args) => { log('warning', args); console.warn(...args); },
        info: (...args) => { log('info', args); },
    };
}

const logger = makeServerLogger();

// ─── Query ───────────────────────────────────────────────────────────────────
function queryLogs({ level, origin, since, before, limit } = {}) {
    const conditions = [];
    const params = [];
    if (level) { conditions.push(`level = ?`); params.push(level); }
    if (origin) { conditions.push(`origin = ?`); params.push(origin); }
    if (typeof since === 'number') { conditions.push(`timestamp >= ?`); params.push(since); }
    if (typeof before === 'number') { conditions.push(`timestamp < ?`); params.push(before); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const lim = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    const sql = `SELECT * FROM logs ${where} ORDER BY id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, lim);
    return rows.map(r => ({
        id: r.id,
        timestamp: r.timestamp,
        level: r.level,
        origin: r.origin,
        message: r.message,
        description: r.description,
        source: r.source,
        count: r.count,
        platform: r.platform,
        clientId: r.client_id,
        userAgent: r.user_agent,
    }));
}

function clearLogs() {
    stmtClearAll.run();
    rotateCounter = 0;
}

function countLogs() {
    const row = stmtCount.get();
    return row ? row.n : 0;
}

// ─── Global error handlers ──────────────────────────────────────────────────
let handlersInstalled = false;
function installProcessHandlers() {
    if (handlersInstalled) return;
    handlersInstalled = true;

    process.on('uncaughtException', (err) => {
        try {
            addLog({
                timestamp: Date.now(),
                level: 'error',
                origin: 'server',
                source: 'uncaught',
                message: err?.message || String(err),
                description: err?.stack,
                platform: serverPlatform,
            });
        } catch {}
        console.error('[uncaughtException]', err);
    });

    process.on('unhandledRejection', (reason) => {
        try {
            const err = reason instanceof Error ? reason : null;
            addLog({
                timestamp: Date.now(),
                level: 'error',
                origin: 'server',
                source: 'promise',
                message: err?.message || String(reason),
                description: err?.stack,
                platform: serverPlatform,
            });
        } catch {}
        console.error('[unhandledRejection]', reason);
    });
}

// ─── Express middleware ─────────────────────────────────────────────────────
function expressErrorMiddleware(err, req, res, next) {
    try {
        addLog({
            timestamp: Date.now(),
            level: 'error',
            origin: 'server',
            source: 'express',
            message: `${req.method} ${req.path} — ${err?.message || 'error'}`,
            description: err?.stack,
            platform: serverPlatform,
        });
    } catch {}
    next(err);
}

module.exports = {
    addLog,
    addLogBatch,
    queryLogs,
    clearLogs,
    countLogs,
    logger,
    installProcessHandlers,
    expressErrorMiddleware,
    maskSensitive,
};
