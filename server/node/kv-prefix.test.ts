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
})
