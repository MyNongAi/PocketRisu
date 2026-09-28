'use strict';

const SNAPSHOT_HOUR_MS = 60 * 60 * 1000;
const SNAPSHOT_INTERVAL_DEFAULT_MS = 12 * SNAPSHOT_HOUR_MS;
const SNAPSHOT_INTERVAL_OPTIONS_MS = Object.freeze([
    0,
    SNAPSHOT_HOUR_MS,
    6 * SNAPSHOT_HOUR_MS,
    SNAPSHOT_INTERVAL_DEFAULT_MS,
    24 * SNAPSHOT_HOUR_MS,
]);

function isAllowedSnapshotInterval(value) {
    return Number.isInteger(value) && SNAPSHOT_INTERVAL_OPTIONS_MS.includes(value);
}

function parseConfiguredSnapshotInterval(raw) {
    if (raw === null || raw === undefined) return SNAPSHOT_INTERVAL_DEFAULT_MS;
    const text = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
    const value = Number(text.trim());
    return isAllowedSnapshotInterval(value) ? value : SNAPSHOT_INTERVAL_DEFAULT_MS;
}

// The environment override predates the user-facing interval setting and is
// intentionally more permissive: compat tests use 0 to snapshot every write.
// A stored interval of 0, by contrast, means "automatic snapshots disabled".
function parseSnapshotIntervalOverride(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function parseSnapshotTimestamp(key, prefix = 'database/dbbackup-') {
    if (typeof key !== 'string' || !key.startsWith(prefix)) return null;
    const match = /^(\d+)\.bin$/.exec(key.slice(prefix.length));
    if (!match) return null;
    const ticks = Number(match[1]);
    const timestamp = ticks * 100;
    return Number.isSafeInteger(timestamp) ? timestamp : null;
}

function latestSnapshotTimestamp(keys, prefix = 'database/dbbackup-') {
    let latest = null;
    for (const key of keys) {
        const timestamp = parseSnapshotTimestamp(key, prefix);
        if (timestamp !== null && (latest === null || timestamp > latest)) {
            latest = timestamp;
        }
    }
    return latest;
}

// The snapshots a trim deletes, from entries { key, size, ts } (size: the
// marginal disk cost the byte limit counts). Walk newest -> oldest; keep
// within both limits, delete the rest. The most recent snapshot is always
// kept (even if it alone exceeds the byte limit) so a config change never
// leaves zero backups. `protectedKey` (a snapshot being restored) is never
// deleted and not counted.
function selectSnapshotsToTrim(entries, { maxCount, maxBytes }, protectedKey = null) {
    const sorted = entries.slice().sort((a, b) => b.ts - a.ts);
    let runningBytes = 0;
    const toDelete = [];
    for (let i = 0; i < sorted.length; i++) {
        const e = sorted[i];
        const isFirst = i === 0;
        const fitsByCount = i < maxCount;
        const fitsByBytes = runningBytes + e.size <= maxBytes;
        if (e.key === protectedKey) continue;
        if (isFirst || (fitsByCount && fitsByBytes)) {
            runningBytes += e.size;
        } else {
            toDelete.push(e.key);
        }
    }
    return toDelete;
}

module.exports = {
    SNAPSHOT_HOUR_MS,
    SNAPSHOT_INTERVAL_DEFAULT_MS,
    SNAPSHOT_INTERVAL_OPTIONS_MS,
    isAllowedSnapshotInterval,
    latestSnapshotTimestamp,
    parseConfiguredSnapshotInterval,
    parseSnapshotIntervalOverride,
    parseSnapshotTimestamp,
    selectSnapshotsToTrim,
};
