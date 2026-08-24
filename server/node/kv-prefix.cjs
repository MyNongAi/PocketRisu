'use strict';

// Prefix scans used by the storage dashboard must stay bounded even when a
// library contains hundreds of thousands of assets.  better-sqlite3's `.all()`
// materialises every row (and every key string) in JS; these helpers either let
// SQLite return one aggregate row or expose its iterator one row at a time.
function nextPrefix(prefix) {
    const points = Array.from(String(prefix));
    for (let i = points.length - 1; i >= 0; i--) {
        const code = points[i].codePointAt(0);
        if (code < 0x10ffff) {
            return points.slice(0, i).join('') + String.fromCodePoint(code + 1);
        }
    }
    return null;
}

function createKvPrefixQueries(db) {
    const stmtStatsAll = db.prepare(
        'SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(value)), 0) AS totalSize FROM kv',
    );
    const stmtStatsRange = db.prepare(
        'SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(value)), 0) AS totalSize '
        + 'FROM kv WHERE key >= ? AND key < ?',
    );
    const stmtIterateAll = db.prepare('SELECT key, LENGTH(value) AS size FROM kv ORDER BY key');
    const stmtIterateRange = db.prepare(
        'SELECT key, LENGTH(value) AS size FROM kv WHERE key >= ? AND key < ? ORDER BY key',
    );
    const stmtStoredSize = db.prepare('SELECT LENGTH(value) AS size FROM kv WHERE key = ?');

    function bounds(prefix) {
        const lower = String(prefix ?? '');
        return { lower, upper: nextPrefix(lower) };
    }

    function prefixStats(prefix) {
        const { lower, upper } = bounds(prefix);
        const row = lower === '' || upper == null
            ? stmtStatsAll.get()
            : stmtStatsRange.get(lower, upper);
        return {
            count: Number(row?.count || 0),
            totalSize: Number(row?.totalSize || 0),
        };
    }

    function iterateWithSizes(prefix) {
        const { lower, upper } = bounds(prefix);
        return lower === '' || upper == null
            ? stmtIterateAll.iterate()
            : stmtIterateRange.iterate(lower, upper);
    }

    function storedSize(key) {
        const row = stmtStoredSize.get(String(key));
        return row ? Number(row.size) : null;
    }

    // One full-table pass for the dashboard's global KV total and all of its
    // fixed namespace slices.  Running prefixStats() for each slice and then a
    // separate all-row total revisits a 500k-row asset table several times.
    function summarizePrefixes(prefixes) {
        const entries = prefixes.map((prefix) => {
            const range = bounds(prefix);
            if (!range.lower || range.upper == null) {
                throw new Error('summarizePrefixes requires non-empty, bounded prefixes');
            }
            return range;
        });
        const columns = [
            'COUNT(*) AS allCount',
            'COALESCE(SUM(LENGTH(value)), 0) AS allTotalSize',
        ];
        const params = [];
        for (let i = 0; i < entries.length; i++) {
            columns.push(`COALESCE(SUM(CASE WHEN key >= ? AND key < ? THEN 1 ELSE 0 END), 0) AS count${i}`);
            columns.push(`COALESCE(SUM(CASE WHEN key >= ? AND key < ? THEN LENGTH(value) ELSE 0 END), 0) AS size${i}`);
            params.push(entries[i].lower, entries[i].upper, entries[i].lower, entries[i].upper);
        }
        const row = db.prepare(`SELECT ${columns.join(', ')} FROM kv`).get(...params);
        const byPrefix = {};
        prefixes.forEach((prefix, i) => {
            byPrefix[prefix] = {
                count: Number(row?.[`count${i}`] || 0),
                totalSize: Number(row?.[`size${i}`] || 0),
            };
        });
        return {
            all: {
                count: Number(row?.allCount || 0),
                totalSize: Number(row?.allTotalSize || 0),
            },
            prefixes: byPrefix,
        };
    }

    return { prefixStats, iterateWithSizes, storedSize, summarizePrefixes };
}

module.exports = { createKvPrefixQueries, nextPrefix };
