import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import pkg from './chunkStore.cjs'

const { cdcSplit, createChunkStore } = pkg as {
    cdcSplit: (buf: Buffer) => { hash: string; data: Buffer }[]
    createChunkStore: (
        db: any,
        opts?: { threshold?: number },
    ) => {
        putValue: (key: string, value: Buffer) => void
        getValue: (key: string) => Buffer | null
        sizeValue: (key: string) => number | null
    }
}

// Fresh in-memory DB with the same kv schema db.cjs creates (kv is db.cjs's
// domain; chunkStore creates only its own chunks/manifest tables).
function freshDb() {
    const db = new Database(':memory:')
    db.exec(
        'CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)',
    )
    return db
}
// Deterministic pseudo-random bytes (LCG) — reproducible so locality/dedup
// assertions never flake on RNG luck.
function seededBytes(n: number, seed = 1): Buffer {
    const out = Buffer.alloc(n)
    let h = seed >>> 0
    for (let i = 0; i < n; i++) {
        h = (Math.imul(h, 1664525) + 1013904223) >>> 0
        out[i] = h >>> 24
    }
    return out
}
const countChunks = (db: any) => db.prepare('SELECT COUNT(*) c FROM chunks').get().c as number
const countManifest = (db: any, key: string) =>
    db.prepare('SELECT COUNT(*) c FROM manifest_chunks WHERE manifest_key = ?').get(key).c as number

describe('cdcSplit — content-defined chunking (pure)', () => {
    it('A1: 분할한 조각을 다시 이으면 원본과 바이트 동일', () => {
        const buf = randomBytes(200_000)
        const chunks = cdcSplit(buf)
        const reassembled = Buffer.concat(chunks.map((c) => c.data))
        expect(reassembled.equals(buf)).toBe(true)
    })

    it('A1b: 빈 버퍼는 조각 0개, 재조립은 빈 버퍼', () => {
        const chunks = cdcSplit(Buffer.alloc(0))
        expect(chunks).toHaveLength(0)
        expect(Buffer.concat(chunks.map((c) => c.data)).length).toBe(0)
    })

    it('A2: 같은 입력 → 같은 조각(경계·해시 결정적)', () => {
        const buf = randomBytes(200_000)
        const a = cdcSplit(buf).map((c) => c.hash)
        const b = cdcSplit(buf).map((c) => c.hash)
        expect(b).toEqual(a)
    })

    it('A3: 조각 크기가 min/max 경계 준수 (마지막 제외 ≥MIN, 전부 ≤MAX)', () => {
        const chunks = cdcSplit(randomBytes(500_000))
        chunks.forEach((c, i) => {
            expect(c.data.length).toBeLessThanOrEqual(65536)
            if (i < chunks.length - 1) expect(c.data.length).toBeGreaterThanOrEqual(4096)
        })
    })

    it('A4: 중간 삽입 시 변경 조각은 극소수 (CDC 재동기화 → dedup)', () => {
        const buf = seededBytes(2_000_000, 7)
        const at = 1_000_000
        const mutated = Buffer.concat([buf.subarray(0, at), seededBytes(120, 99), buf.subarray(at)])
        const base = cdcSplit(buf)
        const next = cdcSplit(mutated)
        const baseHashes = new Set(base.map((c) => c.hash))
        const changed = next.filter((c) => !baseHashes.has(c.hash))
        // 삽입 지점 한 조각 + 경계 정렬로 최대 몇 개. 버퍼 크기와 무관하게 소수.
        expect(changed.length).toBeLessThanOrEqual(3)
        const rewriteBytes = changed.reduce((s, c) => s + c.data.length, 0)
        expect(rewriteBytes).toBeLessThanOrEqual(3 * 65536) // 최대 3개 max-chunk 분량
    })
})

describe('createChunkStore — chunk-aware kv (injected :memory: db)', () => {
    const T = { threshold: 1024 } // small threshold so test buffers exercise chunking

    it('B1: putValue(big) → getValue 바이트 동일 (라운드트립)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const buf = randomBytes(200_000)
        store.putValue('database/database.bin', buf)
        const got = store.getValue('database/database.bin')
        expect(got).not.toBeNull()
        expect((got as Buffer).equals(buf)).toBe(true)
        expect(countManifest(db, 'database/database.bin')).toBeGreaterThan(1) // 실제로 청킹됨
    })

    it('B2: 작은 값(<임계)은 평범한 행 — 청크 0', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const small = randomBytes(500)
        store.putValue('k', small)
        expect(countChunks(db)).toBe(0)
        expect(countManifest(db, 'k')).toBe(0)
        expect((store.getValue('k') as Buffer).equals(small)).toBe(true)
    })

    it('B3: 레거시 raw BLOB(마커 없음)은 그대로 반환', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const legacy = randomBytes(50_000) // 마커 없이 직접 박힌 옛 값
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run('database/database.bin', legacy)
        expect((store.getValue('database/database.bin') as Buffer).equals(legacy)).toBe(true)
    })

    it('B3b: 레거시 값을 putValue로 덮으면 청킹으로 마이그레이션', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run('k', randomBytes(50_000))
        const next = randomBytes(200_000)
        store.putValue('k', next)
        expect(countManifest(db, 'k')).toBeGreaterThan(1)
        expect((store.getValue('k') as Buffer).equals(next)).toBe(true)
    })

    it('B4: dedup — 유사 버퍼 2개는 chunks가 델타만큼만 증가', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const buf1 = randomBytes(200_000)
        store.putValue('k', buf1)
        const n1 = countChunks(db)
        const at = 100_000
        const buf2 = Buffer.concat([buf1.subarray(0, at), randomBytes(120), buf1.subarray(at)])
        store.putValue('k', buf2)
        expect(countChunks(db)).toBeLessThanOrEqual(n1 + 3) // 공유 조각은 INSERT OR IGNORE로 재기록 안 됨
    })

    it('B5: 축소/덮어쓰기 — big→small이면 manifest 비워지고 정확 반환', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('k', randomBytes(200_000))
        expect(countManifest(db, 'k')).toBeGreaterThan(1)
        const small = randomBytes(300)
        store.putValue('k', small)
        expect(countManifest(db, 'k')).toBe(0)
        expect((store.getValue('k') as Buffer).equals(small)).toBe(true)
    })

    it('B6: sizeValue는 논리 크기 반환 (청킹 여부 무관)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const big = randomBytes(200_000)
        store.putValue('big', big)
        store.putValue('small', randomBytes(300))
        expect(store.sizeValue('big')).toBe(big.length)
        expect(store.sizeValue('small')).toBe(300)
        expect(store.sizeValue('missing')).toBeNull()
    })

    it('B7: 없는 키는 null', () => {
        const store = createChunkStore(freshDb(), T)
        expect(store.getValue('nope')).toBeNull()
    })
})
