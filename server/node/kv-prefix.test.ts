import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import pkg from './kv-prefix.cjs'

const { createKvPrefixQueries, nextPrefix } = pkg as {
    createKvPrefixQueries: (db: any) => {
        prefixStats: (prefix: string) => { count: number; totalSize: number }
        iterateWithSizes: (prefix: string) => Iterable<{ key: string; size: number }>
        storedSize: (key: string) => number | null
        summarizePrefixes: (prefixes: string[]) => {
            all: { count: number; totalSize: number }
            prefixes: Record<string, { count: number; totalSize: number }>
        }
        listKeys: (prefix: string) => string[]
        exists: (key: string) => boolean
        listLikeWithSizes: (prefix: string) => { key: string; size: number }[]
        deleteLike: (prefix: string) => number
    }
    nextPrefix: (prefix: string) => string | null
}

function fixture() {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL)')
    const insert = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)')
    insert.run('assets/a.png', Buffer.alloc(3))
    insert.run('assets/b.webp', Buffer.alloc(7))
    insert.run('assets_extra/not-an-asset', Buffer.alloc(100))
    insert.run('inlay_meta/a', Buffer.alloc(11))
    // Prefix characters that are special to SQL LIKE must remain literal.
    insert.run('literal%/one', Buffer.alloc(13))
    insert.run('literalX/one', Buffer.alloc(17))
    return db
}

describe('bounded KV prefix queries', () => {
    it('aggregates count and bytes without returning the matching rows', () => {
        const db = fixture()
        const { prefixStats } = createKvPrefixQueries(db)
        expect(prefixStats('assets/')).toEqual({ count: 2, totalSize: 10 })
        expect(prefixStats('missing/')).toEqual({ count: 0, totalSize: 0 })
        expect(prefixStats('')).toEqual({ count: 6, totalSize: 151 })
    })

    it('combines the global total and several prefix slices in one result', () => {
        const db = fixture()
        const { summarizePrefixes } = createKvPrefixQueries(db)
        expect(summarizePrefixes(['assets/', 'inlay_meta/'])).toEqual({
            all: { count: 6, totalSize: 151 },
            prefixes: {
                'assets/': { count: 2, totalSize: 10 },
                'inlay_meta/': { count: 1, totalSize: 11 },
            },
        })
    })

    it('streams the same exact, literal prefix and sizes', () => {
        const db = fixture()
        const { iterateWithSizes, storedSize } = createKvPrefixQueries(db)
        const rows = [...iterateWithSizes('literal%/')]
        expect(rows).toEqual([{ key: 'literal%/one', size: 13 }])
        expect(iterateWithSizes('assets/')).not.toBeInstanceOf(Array)
        expect(storedSize('assets/b.webp')).toBe(7)
        expect(storedSize('missing')).toBeNull()
    })

    it('builds a strict lexicographic upper bound', () => {
        expect(nextPrefix('assets/')).toBe('assets0')
        expect(nextPrefix('')).toBeNull()
    })

    // db.cjs kvList(prefix), the LIKE scan these replace on the save path.
    function likeKeys(db: any, prefix: string): string[] {
        const escaped = prefix.replace(/[\\%_]/g, '\\$&')
        return db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'").all(`${escaped}%`).map((r: any) => r.key)
    }

    it('lists the same keys as the LIKE prefix scan for the save-path prefixes', () => {
        const db = fixture()
        const insert = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)')
        const keys = [
            'archive/char-1/1700000000000', 'archive/char-1/1700000000001', 'archive/char-10/1700000000002',
            'archive/char-1x/1', 'archive-meta/char-1/1700000000000', 'archive/char_1/5',
            'database/database.bin', 'database/dbbackup-17000000000.bin', 'database/dbbackup-17000000001.bin',
            'database/dbbackupX', 'chat-payload-pending/5b2261222c2262225d', 'chat-payload-pending/00',
            'chat-payload-pendingX/00',
        ]
        for (const key of keys) insert.run(key, Buffer.alloc(1))
        const { listKeys } = createKvPrefixQueries(db)
        for (const prefix of ['archive/char-1/', 'archive/char_1/', 'archive/missing/', 'database/dbbackup-',
            'chat-payload-pending/', 'literal%/', 'assets/']) {
            expect(listKeys(prefix), prefix).toEqual(likeKeys(db, prefix).sort())
        }
        expect(listKeys('')).toEqual(likeKeys(db, '').sort())
    })

    it('matches the prefix exactly: case-sensitive, wildcards literal, any code point after it', () => {
        const db = fixture()
        const insert = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)')
        for (const key of ['archive/Abc/1', 'archive/abc/1', 'archive/abc/\u00e9', 'archive/abc/\u{1F600}', 'archive/abc0', 'archive/ab%/1', 'x\u{10FFFF}y'])
            insert.run(key, Buffer.alloc(1))
        const { listKeys } = createKvPrefixQueries(db)
        expect(listKeys('archive/abc/')).toEqual(['archive/abc/1', 'archive/abc/\u00e9', 'archive/abc/\u{1F600}'])
        // LIKE folds ASCII case, so it also returned the other character's rows.
        expect(likeKeys(db, 'archive/abc/').sort()).toEqual(['archive/Abc/1', 'archive/abc/1', 'archive/abc/\u00e9', 'archive/abc/\u{1F600}'])
        expect(listKeys('archive/ab%/')).toEqual(['archive/ab%/1'])
        expect(listKeys('x\u{10FFFF}')).toEqual(['x\u{10FFFF}y'])
    })

    it('answers from the primary-key index instead of scanning every row', () => {
        const db = fixture()
        const plan = (sql: string) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('a', 'b').map((r: any) => r.detail).join(' | ')
        expect(plan('SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY key')).toMatch(/USING (COVERING )?INDEX sqlite_autoindex_kv_1 \(key>\? AND key<\?\)/)
        expect(db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM kv WHERE key = ?').all('a').map((r: any) => r.detail).join(' | '))
            .toMatch(/USING (COVERING )?INDEX sqlite_autoindex_kv_1 \(key=\?\)/)
        // The LIKE scan it replaces reads the whole table.
        expect(plan("SELECT key FROM kv WHERE key LIKE ? || ? ESCAPE '\\'")).toMatch(/SCAN/)
    })

    it('tells whether a row exists without reading its value', () => {
        const db = fixture()
        const { exists } = createKvPrefixQueries(db)
        expect(exists('assets/a.png')).toBe(true)
        expect(exists('assets/A.png')).toBe(false)
        expect(exists('assets/')).toBe(false)
        expect(exists('missing')).toBe(false)
    })
})

describe('LIKE prefix listing and delete through the key index', () => {
    // What db.cjs ran before: LIKE over a scan of the table.
    const escapeLike = (prefix: string) => `${prefix.replace(/[\\%_]/g, '\\$&')}%`
    const scanList = (db: any, prefix: string) => db.prepare("SELECT key, LENGTH(value) as size FROM kv WHERE key LIKE ? ESCAPE '\\'")
        .all(escapeLike(prefix)).map((r: any) => ({ key: r.key, size: r.size }))
    const scanDelete = (db: any, prefix: string) => db.prepare("DELETE FROM kv WHERE key LIKE ? ESCAPE '\\'").run(escapeLike(prefix))
    const rows = (db: any) => db.prepare('SELECT rowid, key, LENGTH(value) AS size FROM kv ORDER BY rowid').all()
    const heads = ['plugin-storage/', 'PLUGIN-STORAGE/', 'Plugin-Storage-Snapshot/', 'plugin-storage-snapshot/', 'plugin-storage-blob/',
        'database/dbbackup-1', 'DATABASE/DBBACKUP-2', 'a_b/', 'aXb/', 'a%b/', 'a\\b/', 'a\\\\b/', 'assets/', 'Assets/', 'é/', 'É/', 'z']

    for (let seed = 1; seed <= 8; seed++) {
        it(`returns the rows, sizes and order of the table scan, and deletes the same rows, seed ${seed}`, () => {
            let s = seed
            const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
            const make = () => {
                const db = new Database(':memory:')
                db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL)')
                return db
            }
            const a = make()
            const b = make()
            // Keys in random order, some deleted and inserted again, so the
            // rowid order is not the key order.
            const ops: [string, string, number][] = []
            for (let i = 0; i < 300; i++) {
                const key = `${heads[Math.floor(rand() * heads.length)]}${Math.floor(rand() * 60)}`
                ops.push([rand() < 0.2 ? 'del' : 'put', key, Math.floor(rand() * 5000)])
            }
            for (const db of [a, b]) {
                const put = db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
                const del = db.prepare('DELETE FROM kv WHERE key = ?')
                for (const [op, key, size] of ops) {
                    if (op === 'put') put.run(key, Buffer.alloc(size, 1))
                    else del.run(key)
                }
            }
            const { listLikeWithSizes, deleteLike } = createKvPrefixQueries(a)
            for (const prefix of [...heads, 'plugin-storage', 'a_', 'a%', 'a\\', 'database/', '', 'missing/']) {
                expect(listLikeWithSizes(prefix), prefix).toEqual(scanList(a, prefix))
            }
            for (const prefix of ['plugin-storage-snapshot/', 'a_b/', 'database/dbbackup-1', 'a\\b/', 'Assets/']) {
                expect(deleteLike(prefix)).toBe(scanDelete(b, prefix).changes)
                expect(rows(a)).toEqual(rows(b))
            }
        })
    }

    it('reads only the matching rows', () => {
        const db = fixture()
        const plan = db.prepare("EXPLAIN QUERY PLAN SELECT key, LENGTH(value) AS size FROM kv WHERE rowid IN (SELECT rowid FROM kv WHERE key LIKE ? ESCAPE '\\') ORDER BY rowid")
            .all('a%').map((r: any) => r.detail).join(' | ')
        expect(plan).toMatch(/SCAN kv USING COVERING INDEX sqlite_autoindex_kv_1/)
        expect(plan).toMatch(/SEARCH kv USING INTEGER PRIMARY KEY/)
    })
})
