'use strict';

// Runtime switches for a running server: edit save/pocketrisu-flags.json and
// the next lookup after at most STAT_INTERVAL_MS sees the change, no restart.
// Meant as kill switches for new save-path behavior on the live machine.
//
// Where a flag's value comes from, first match wins:
//   1. POCKETRISU_FLAG_<NAME>: one flag, name in upper snake case
//      (incrementalPersist -> POCKETRISU_FLAG_INCREMENTAL_PERSIST);
//   2. POCKETRISU_FLAGS_JSON: a JSON object of flags;
//   3. the file, a JSON object of flags;
//   4. the defaults given to createRuntimeFlags.
// Env values are parsed as JSON when they parse ("0", "false", "12"), else
// kept as strings. A missing file means the defaults. A file that does not
// parse keeps the values last read from it, so a half-saved edit cannot flip
// a switch, and is logged once per version.

const fs = require('fs');
const path = require('path');

const FLAGS_FILE_NAME = 'pocketrisu-flags.json';
const STAT_INTERVAL_MS = 2000;

function flagEnvName(name) {
    return 'POCKETRISU_FLAG_' + String(name)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .toUpperCase();
}

function parseEnvValue(raw) {
    try { return JSON.parse(raw); } catch { return raw; }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createRuntimeFlags({
    file = path.join(process.cwd(), 'save', FLAGS_FILE_NAME),
    defaults = {},
    env = process.env,
    now = Date.now,
    statIntervalMs = STAT_INTERVAL_MS,
    logger = console,
} = {}) {
    let envFlags = {};
    if (env.POCKETRISU_FLAGS_JSON) {
        try {
            const parsed = JSON.parse(env.POCKETRISU_FLAGS_JSON);
            if (!isPlainObject(parsed)) throw new Error('not a JSON object');
            envFlags = parsed;
        } catch (error) {
            logger.warn?.(`[Flags] POCKETRISU_FLAGS_JSON ignored: ${error.message}`);
        }
    }

    let fileFlags = {};
    let fileStamp = null; // mtime/ctime/size of the version last read; null when absent
    let checkedAt = -Infinity;

    function refresh() {
        const t = now();
        if (t - checkedAt < statIntervalMs) return;
        checkedAt = t;
        let stat;
        try {
            stat = fs.statSync(file);
        } catch (error) {
            if (error?.code === 'ENOENT') {
                fileFlags = {};
                fileStamp = null;
            } else if (fileStamp !== `error:${error?.code}`) {
                // Unreadable is not "deleted": keep the last values.
                fileStamp = `error:${error?.code}`;
                logger.warn?.(`[Flags] ${file} unreadable, keeping the last values: ${error?.message || error}`);
            }
            return;
        }
        const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
        if (stamp === fileStamp) return;
        fileStamp = stamp;
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (!isPlainObject(parsed)) throw new Error('not a JSON object');
            fileFlags = parsed;
        } catch (error) {
            logger.warn?.(`[Flags] ${file} ignored, keeping the last values: ${error.message}`);
        }
    }

    const has = (object, name) => Object.prototype.hasOwnProperty.call(object, name);

    function get(name) {
        refresh();
        const raw = env[flagEnvName(name)];
        if (raw !== undefined && raw !== '') return parseEnvValue(raw);
        if (has(envFlags, name)) return envFlags[name];
        if (has(fileFlags, name)) return fileFlags[name];
        return defaults[name];
    }

    // Every known flag (defaults, file, POCKETRISU_FLAGS_JSON) with its value.
    function all() {
        refresh();
        const out = {};
        for (const name of new Set([...Object.keys(defaults), ...Object.keys(fileFlags), ...Object.keys(envFlags)])) {
            out[name] = get(name);
        }
        return out;
    }

    return { get, all, file };
}

module.exports = { createRuntimeFlags, flagEnvName, FLAGS_FILE_NAME, STAT_INTERVAL_MS };
