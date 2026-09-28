/**
 * The chunk-store pieces the incremental database persister builds on:
 * chunkLength (cdcSplit's cut rule, factored out, with golden output),
 * per-key write generations, manifests with lengths, the chunk reader, and
 * commitChunks (full replace, gapped in-place edits, the stale-layout
 * precondition, read-back and rollback), plus every reader on a gapped
 * manifest; and the snapshot sizing the trim uses (snapshotCosts, the same
 * numbers and decisions as one snapshotCost query per snapshot).
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import pkg from './chunkStore.cjs'
import policy from './snapshot-policy.cjs'

type ChunkList = { hashes: string[], lens: number[], data: (Buffer | null)[], reused?: number[] }
const {
    cdcSplit, chunkLength, chunkStarts, createChunkStore, planManifestEdit, CHUNK_MARKER, MAX_SIZE, SEQ_GAP,
} = pkg as any
const { selectSnapshotsToTrim } = policy as any

const KEY = 'database/database.bin'

function freshDb() {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)')
    return db
}

function seededBytes(n: number, seed = 1): Buffer {
    const out = Buffer.alloc(n)
    let h = seed >>> 0
    for (let i = 0; i < n; i++) {
        h = (Math.imul(h, 1664525) + 1013904223) >>> 0
        out[i] = h >>> 24
    }
    return out
}

function digestOf(chunks: { hash: string, data: Buffer }[]) {
    return createHash('sha256').update(chunks.map((c) => `${c.data.length}:${c.hash}`).join(',')).digest('hex')
}

function listOf(buf: Buffer): ChunkList {
    const chunks = cdcSplit(buf)
    return { hashes: chunks.map((c: any) => c.hash), lens: chunks.map((c: any) => c.data.length), data: chunks.map((c: any) => c.data) }
}

function manifestRows(db: any, key = KEY): { seq: number, hash: string }[] {
    return db.prepare('SELECT seq, hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq').all(key)
}

// A chunk list for `next` that reuses chunks of `prev` wherever cdcSplit
// produced the same chunk at the same position relative to an unchanged
// prefix/suffix — what the persister's chunk planner hands commitChunks.
function editedList(prev: ChunkList, next: Buffer): ChunkList {
    const list = listOf(next)
    const oldIndex = new Map<string, number[]>()
    prev.hashes.forEach((h, i) => { const a = oldIndex.get(h) ?? []; a.push(i); oldIndex.set(h, a) })
    let last = -1
    const reused = list.hashes.map((h) => {
        const j = (oldIndex.get(h) ?? []).find((x) => x > last)
        if (j === undefined) return -1
        last = j
        return j
    })
    return { ...list, reused, data: list.data.map((d, i) => (reused[i] >= 0 ? null : d)) }
}

describe('chunkLength / cdcSplit', () => {
    // Digests of cdcSplit output recorded before chunkLength was factored out.
    const golden: Record<string, [Buffer, number, string]> = {
        empty: [Buffer.alloc(0), 0, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
        tiny: [seededBytes(100, 9), 1, '6abdd34b3ded838e8dc043e7000ee39227a9adc426e2a265c467432038ab3f84'],
        min: [seededBytes(4096, 10), 1, '2c5c5882501da0b56cb7ed039d12b6736f1e5981fb850ce63da950b4e037ea1c'],
        minPlus: [seededBytes(4097, 11), 1, 'b77730afc7ccc870f7736d6a39189e355c528ae1f84946a771f78f819c300ee9'],
        max: [seededBytes(65536, 12), 6, 'daef23ffbd99b33652012bb950811b50879280205b5055b1ead095f9f9b300b2'],
        maxPlus: [seededBytes(65537, 13), 4, '26a6e06e5d80fd8790267214bafb9fd90d10b2c4b7fc0586d00efccbebadf737'],
        random: [seededBytes(1_000_000, 7), 55, 'a1808f8ab49bf073c9a752fba149230c8495a5cd8d5e7160179b3eef9a4d6a55'],
        constRun: [Buffer.concat([seededBytes(10000, 3), Buffer.alloc(300000, 0x41), seededBytes(50000, 4), Buffer.alloc(70000, 0)]), 8,
            'cebb915dda805841992f2cfed37a720b0bdd33300e2430833ba8eb59becd3341'],
        text: [Buffer.from(Array.from({ length: 20000 }, (_, i) => `message ${i} ${'x'.repeat(i % 97)}\n`).join('')), 20,
            'f49f0edc32e93470a4721344d428c8f337812b604432d6591cc575db9fbf63df'],
    }

    it.each(Object.keys(golden))('keeps the golden cdcSplit output: %s', (name) => {
        const [buf, count, digest] = golden[name]
        const chunks = cdcSplit(buf)
        expect(chunks.length).toBe(count)
        expect(digestOf(chunks)).toBe(digest)
    })

    it('cuts a window of MAX_SIZE bytes exactly where cdcSplit cuts the whole buffer', () => {
        const buf = Buffer.concat([seededBytes(300_000, 5), Buffer.alloc(200_000, 7), seededBytes(90_000, 6)])
        let start = 0
        for (const chunk of cdcSplit(buf)) {
            const window = buf.subarray(start, Math.min(start + MAX_SIZE, buf.length))
            expect(chunkLength(window, 0)).toBe(chunk.data.length)
            expect(chunkLength(buf, start)).toBe(chunk.data.length)
            start += chunk.data.length
        }
        expect(start).toBe(buf.length)
    })
})

describe('generation', () => {
    it('moves on every write of the key through the store, and only for that key', () => {
        const db = freshDb()
        const store = createChunkStore(db, { threshold: 1024 })
        const seen = [store.generation(KEY)]
        const other = store.generation('other')
        store.putValue(KEY, seededBytes(50_000, 1)); seen.push(store.generation(KEY))
        store.snapshotValue(KEY, 'snap'); seen.push(store.generation(KEY))
        expect(seen[2]).toBe(seen[1]) // snapshotting FROM the key does not change it
        store.snapshotValue('snap', KEY); seen.push(store.generation(KEY))
        const list = listOf(seededBytes(60_000, 2))
        store.commitChunks(KEY, list); seen.push(store.generation(KEY))
        store.dropValue(KEY); seen.push(store.generation(KEY))
        expect(seen[0]).toBe(0)
        for (const i of [1, 3, 4, 5]) expect(seen[i]).toBeGreaterThan(seen[i - 1])
        expect(store.generation('other')).toBe(other)
    })

    it('moves even when the write fails', () => {
        const db = freshDb()
        const store = createChunkStore(db, { threshold: 1024 })
        store.putValue(KEY, seededBytes(50_000, 1))
        const before = store.generation(KEY)
        expect(() => store.commitChunks(KEY, listOf(seededBytes(50_000, 3)), ['not the live list'])).toThrow(expect.objectContaining({ code: 'STALE_LAYOUT' }))
        expect(store.generation(KEY)).toBeGreaterThan(before)
    })
})

describe('readManifestWithLengths and createReader', () => {
    it('return the live chunk list and its bytes', () => {
        const db = freshDb()
        const store = createChunkStore(db, { threshold: 1024 })
        const buf = seededBytes(400_000, 9)
        store.putValue(KEY, buf)
        const m = store.readManifestWithLengths(KEY)
        const ref = listOf(buf)
        expect(m.hashes).toEqual(ref.hashes)
        expect(m.lens).toEqual(ref.lens)
        expect(m.seqs).toEqual(ref.hashes.map((_, i) => i))
        const reader = store.createReader({ hashes: m.hashes, lens: m.lens }, { cacheChunks: 2 })
        expect(reader.total).toBe(buf.length)
        for (const [off, len] of [[0, 1], [0, 70_000], [12_345, 1], [100_000, 150_000], [buf.length - 3, 3], [5, 0]]) {
            expect(reader.read(off, len).equals(buf.subarray(off, off + len))).toBe(true)
        }
        const into = Buffer.alloc(20)
        reader.readInto(into, 10, 399_990, 10)
        expect(into.subarray(10).equals(buf.subarray(399_990))).toBe(true)
        expect(() => reader.read(buf.length - 1, 2)).toThrow(RangeError)
    })

    it('reports a manifest row whose chunk is gone', () => {
        const db = freshDb()
        const store = createChunkStore(db, { threshold: 1024 })
        store.putValue(KEY, seededBytes(100_000, 4))
        const [first] = store.readManifestWithLengths(KEY).hashes
        db.prepare('DELETE FROM chunks WHERE hash = ?').run(first)
        expect(() => store.readManifestWithLengths(KEY)).toThrow(expect.objectContaining({ code: 'MISSING_CHUNK' }))
    })
})

describe('commitChunks', () => {
    it('without an expected list writes exactly what putValue writes', () => {
        const buf = seededBytes(500_000, 21)
        const a = freshDb()
        createChunkStore(a, { threshold: 1024 }).putValue(KEY, buf)
        const b = freshDb()
        const store = createChunkStore(b, { threshold: 1024 })
        const result = store.commitChunks(KEY, listOf(buf))
        expect(result.mode).toBe('full')
        expect(manifestRows(b)).toEqual(manifestRows(a))
        expect(store.getValue(KEY).equals(buf)).toBe(true)
        expect(b.prepare('SELECT value FROM kv WHERE key = ?').get(KEY).value.equals(CHUNK_MARKER)).toBe(true)
    })

    it('edits a live manifest in place: kept rows keep their seq, few rows change', () => {
        const db = freshDb()
        const store = createChunkStore(db, { threshold: 1024 })
        const base = seededBytes(2_000_000, 31)
        const first = listOf(base)
        store.commitChunks(KEY, first, null, { firstSeq: SEQ_GAP, seqStride: SEQ_GAP })
        const edited = Buffer.concat([base.subarray(0, 1_000_000), Buffer.from('an edit in the middle'), base.subarray(1_000_000)])
        const next = editedList(first, edited)
        const before = new Map(manifestRows(db).map((r) => [r.hash, r.seq]))
        const result = store.commitChunks(KEY, next, first.hashes)
        expect(result.mode).toBe('gapped')
        expect(result.insertedRows).toBeLessThanOrEqual(3)
        expect(result.deletedRows).toBeLessThanOrEqual(3)
        expect(store.getValue(KEY).equals(edited)).toBe(true)
        const rows = manifestRows(db)
        expect(rows.map((r) => r.hash)).toEqual(next.hashes)
        for (let i = 1; i < rows.length; i++) expect(rows[i].seq).toBeGreaterThan(rows[i - 1].seq)
        next.hashes.forEach((h, i) => { if (next.reused![i] >= 0) expect(rows[i].seq).toBe(before.get(h)) })
    })

    it('renumbers when a gap is exhausted, and after a reorder', () => {
        const db = freshDb()
        const store = createChunkStore(db, { threshold: 1024 })
        let buf = seededBytes(600_000, 41)
        let list = listOf(buf)
        store.commitChunks(KEY, list) // seq 0, 1, 2, …: no room between rows
        const modes = new Set<string>()
        for (let round = 0; round < 12; round++) {
            const at = 50_000 + round * 37_000
            const next = Buffer.concat([buf.subarray(0, at), seededBytes(9_000, 100 + round), buf.subarray(at)])
            const edit = editedList(list, next)
            modes.add(store.commitChunks(KEY, edit, list.hashes).mode)
            expect(store.getValue(KEY).equals(next)).toBe(true)
            buf = next
            list = listOf(next)
        }
        expect(modes.has('renumber')).toBe(true)
        expect(modes.has('gapped')).toBe(true)
        // Swap two halves: the chunks come back in another order.
        const half = 300_000
        const swapped = Buffer.concat([buf.subarray(half), buf.subarray(0, half)])
        const edit = editedList(list, swapped)
        store.commitChunks(KEY, edit, list.hashes)
        expect(store.getValue(KEY).equals(swapped)).toBe(true)
    })

    it('refuses a stale layout and changes nothing', () => {
        const db = freshDb()
        const store = createChunkStore(db, { threshold: 1024 })
        const a = seededBytes(300_000, 51)
        const listA = listOf(a)
        store.putValue(KEY, a)
        // Another writer replaces the blob behind the caller's back.
        const b = seededBytes(300_000, 52)
        store.putValue(KEY, b)
        const rowsBefore = manifestRows(db)
        const c = Buffer.concat([a, Buffer.from('more')])
        expect(() => store.commitChunks(KEY, editedList(listA, c), listA.hashes)).toThrow(expect.objectContaining({ code: 'STALE_LAYOUT' }))
        expect(manifestRows(db)).toEqual(rowsBefore)
        expect(store.getValue(KEY).equals(b)).toBe(true)
        // The same list with the right length but one chunk different.
        const tampered = [...store.readManifestWithLengths(KEY).hashes]
        tampered[1] = tampered[0]
        expect(() => store.commitChunks(KEY, listOf(c), tampered)).toThrow(expect.objectContaining({ code: 'STALE_LAYOUT' }))
        // A raw value over the key: not chunked any more.
        db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(Buffer.from('raw'), KEY)
        expect(() => store.commitChunks(KEY, listOf(c), store.readManifestWithLengths(KEY).hashes)).toThrow(expect.objectContaining({ code: 'STALE_LAYOUT' }))
    })

    it('rolls back when the read-back or the caller\'s verify fails', () => {
        const db = freshDb()
        const store = createChunkStore(db, { threshold: 1024 })
        const a = seededBytes(300_000, 61)
        const listA = listOf(a)
        store.commitChunks(KEY, listA)
        const rowsBefore = manifestRows(db)
        const chunksBefore = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n
        const b = Buffer.concat([a.subarray(0, 100_000), Buffer.from('edit'), a.subarray(100_000)])
        expect(() => store.commitChunks(KEY, editedList(listA, b), listA.hashes, { verify: () => { throw new Error('walk failed') } })).toThrow('walk failed')
        expect(manifestRows(db)).toEqual(rowsBefore)
        expect(db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n).toBe(chunksBefore)
        expect(store.getValue(KEY).equals(a)).toBe(true)
        // A chunk that is neither written nor in the live manifest.
        const bad = editedList(listA, b)
        bad.hashes = [...bad.hashes]
        bad.hashes[bad.hashes.length - 1] = 'f'.repeat(64)
        bad.data = bad.data.map((d, i) => (i === bad.hashes.length - 1 ? null : d))
        expect(() => store.commitChunks(KEY, bad, listA.hashes)).toThrow(expect.objectContaining({ code: 'BAD_CHUNK_LIST' }))
        expect(() => store.commitChunks(KEY, { ...bad, data: bad.data.slice(1) }, listA.hashes)).toThrow(expect.objectContaining({ code: 'BAD_CHUNK_LIST' }))
        // Without an expected list every chunk must be written.
        expect(() => store.commitChunks(KEY, { ...listA, data: listA.data.map((d, i) => (i === 0 ? null : d)) })).toThrow(expect.objectContaining({ code: 'BAD_CHUNK_LIST' }))
        expect(manifestRows(db)).toEqual(rowsBefore)
        expect(store.getValue(KEY).equals(a)).toBe(true)
    })

    it('rolls back when the manifest does not read back as the plan', () => {
        const db = freshDb()
        const store = createChunkStore(db, { threshold: 1024 })
        const a = seededBytes(300_000, 62)
        const listA = listOf(a)
        store.commitChunks(KEY, listA)
        const rowsBefore = manifestRows(db)
        const b = Buffer.concat([a.subarray(0, 150_000), Buffer.from('edit'), a.subarray(150_000)])
        // A trigger that drops one of the new rows as it is inserted stands in
        // for a bug in the manifest edit.
        const edit = editedList(listA, b)
        const victim = edit.hashes.find((_, i) => edit.reused![i] < 0)
        expect(victim).toBeTruthy()
        db.exec(`CREATE TEMP TRIGGER drop_one AFTER INSERT ON manifest_chunks WHEN NEW.hash = '${victim}'
                 BEGIN DELETE FROM manifest_chunks WHERE manifest_key = NEW.manifest_key AND seq = NEW.seq; END`)
        expect(() => store.commitChunks(KEY, edit, listA.hashes)).toThrow(expect.objectContaining({ code: 'MANIFEST_READBACK' }))
        db.exec('DROP TRIGGER drop_one')
        expect(manifestRows(db)).toEqual(rowsBefore)
        expect(store.getValue(KEY).equals(a)).toBe(true)
    })
})

describe('a gapped manifest reads like a contiguous one everywhere', () => {
    it('getValue, sizeValue, snapshots, snapshotCost and gc', () => {
        const db = freshDb()
        const store = createChunkStore(db, { threshold: 1024 })
        const a = seededBytes(800_000, 71)
        const listA = listOf(a)
        store.commitChunks(KEY, listA, null, { firstSeq: SEQ_GAP, seqStride: SEQ_GAP })
        const b = Buffer.concat([a.subarray(0, 400_000), seededBytes(3000, 72), a.subarray(400_000)])
        store.commitChunks(KEY, editedList(listA, b), listA.hashes)
        const seqs = manifestRows(db).map((r) => r.seq)
        expect(seqs.some((s, i) => s !== i)).toBe(true)
        expect(store.getValue(KEY).equals(b)).toBe(true)
        expect(store.sizeValue(KEY)).toBe(b.length)
        store.snapshotValue(KEY, 'snap')
        expect(store.getValue('snap').equals(b)).toBe(true)
        expect(store.snapshotCost('snap', KEY)).toBe(0)
        const c = Buffer.concat([b, seededBytes(20_000, 73)])
        const listB = store.readManifestWithLengths(KEY)
        store.commitChunks(KEY, editedList({ hashes: listB.hashes, lens: listB.lens, data: [] }, c), listB.hashes)
        expect(store.getValue(KEY).equals(c)).toBe(true)
        expect(store.getValue('snap').equals(b)).toBe(true)
        expect(store.snapshotCost('snap', KEY)).toBeGreaterThan(0)
        store.gc()
        expect(store.getValue(KEY).equals(c)).toBe(true)
        expect(store.getValue('snap').equals(b)).toBe(true)
        store.dropValue('snap')
        expect(store.gc()).toBeGreaterThan(0)
        expect(store.getValue(KEY).equals(c)).toBe(true)
    })
})

describe('planManifestEdit', () => {
    it('keeps rows of reused chunks and fits new rows between them', () => {
        const live: [number, string][] = [[1024, 'a'], [2048, 'b'], [3072, 'c'], [4096, 'd']]
        const plan = planManifestEdit(live, { hashes: ['a', 'x', 'y', 'c', 'd', 'z'], reused: [0, -1, -1, 2, 3, -1] })
        expect(Array.from(plan.keptOld)).toEqual([0, -1, -1, 2, 3, -1])
        expect(Array.from(plan.kept)).toEqual([1, 0, 1, 1])
        expect(plan.seqs[0]).toBe(1024)
        expect(plan.seqs[1]).toBeGreaterThan(1024)
        expect(plan.seqs[2]).toBeGreaterThan(plan.seqs[1])
        expect(plan.seqs[2]).toBeLessThan(3072)
        expect(plan.seqs.slice(3)).toEqual([3072, 4096, 4096 + SEQ_GAP])
    })

    it('keeps a re-scanned chunk equal to the next live row, and gives up when there is no room', () => {
        const live: [number, string][] = [[0, 'a'], [1, 'b'], [2, 'c']]
        const same = planManifestEdit(live, { hashes: ['a', 'b', 'c'], reused: [-1, -1, -1] })
        expect(Array.from(same.keptOld)).toEqual([0, 1, 2])
        expect(planManifestEdit(live, { hashes: ['a', 'x', 'b', 'c'], reused: [0, -1, 1, 2] })).toBeNull()
    })
})

describe('chunkStarts', () => {
    it('are the running sums of the lengths', () => {
        expect(Array.from(chunkStarts([3, 4, 5]))).toEqual([0, 3, 7])
    })
})

describe('readManifestPage', () => {
    it('reads a gapped manifest in pages, exactly as readManifestWithLengths', () => {
        const db = freshDb()
        const store = createChunkStore(db, { threshold: 1024 })
        const a = seededBytes(600_000, 81)
        const listA = listOf(a)
        store.commitChunks(KEY, listA, null, { firstSeq: SEQ_GAP, seqStride: SEQ_GAP })
        const b = Buffer.concat([a.subarray(0, 200_000), seededBytes(5000, 82), a.subarray(210_000)])
        store.commitChunks(KEY, editedList(listA, b), listA.hashes)
        const whole = store.readManifestWithLengths(KEY)
        for (const limit of [1, 2, 7, 1000]) {
            const got = { seqs: [] as number[], hashes: [] as string[], lens: [] as number[] }
            let after = Number.MIN_SAFE_INTEGER
            for (;;) {
                const page = store.readManifestPage(KEY, after, limit)
                got.seqs.push(...page.seqs)
                got.hashes.push(...page.hashes)
                got.lens.push(...page.lens)
                if (page.hashes.length < limit) break
                after = page.seqs[page.seqs.length - 1]
            }
            expect(got).toEqual(whole)
        }
        db.prepare('DELETE FROM chunks WHERE hash = ?').run(whole.hashes[3])
        expect(() => store.readManifestPage(KEY, whole.seqs[1], 5)).toThrow(expect.objectContaining({ code: 'MISSING_CHUNK' }))
        expect(store.readManifestPage(KEY, whole.seqs[3], 2).hashes).toEqual(whole.hashes.slice(4, 6))
    })
})

describe('matchesChunkList', () => {
    it('is true only for a key stored chunked as exactly that list', () => {
        const db = freshDb()
        const store = createChunkStore(db, { threshold: 1024 })
        const a = seededBytes(300_000, 91)
        store.putValue(KEY, a)
        store.snapshotValue(KEY, 'snap')
        const hashes = store.readManifestWithLengths(KEY).hashes
        expect(store.matchesChunkList('snap', hashes)).toBe(true)
        expect(store.matchesChunkList('snap', hashes.slice(1))).toBe(false)
        expect(store.matchesChunkList('snap', [...hashes.slice(0, -1), hashes[0]])).toBe(false)
        expect(store.matchesChunkList('missing', hashes)).toBe(false)
        store.putValue(KEY, Buffer.concat([a, seededBytes(10, 92)]))
        expect(store.matchesChunkList('snap', store.readManifestWithLengths(KEY).hashes)).toBe(false)
        // A raw value written over a manifest that was not swept yet.
        db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run('snap', Buffer.from('raw'))
        expect(store.matchesChunkList('snap', hashes)).toBe(false)
    })
})

describe('snapshotCosts and the snapshot trim', () => {
    const PREFIX = 'database/dbbackup-'
    function mulberry32(seed: number) {
        return () => {
            seed |= 0
            seed = (seed + 0x6d2b79f5) | 0
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296
        }
    }
    // trimSnapshotsToLimits before snapshotCosts (server.cjs), verbatim but
    // for its inputs: a snapshotCost query per key, then the walk.
    function oldTrim(store: any, keys: string[], pluginBytes: (key: string) => number,
        { maxCount, maxBytes }: { maxCount: number, maxBytes: number }, restoringSnapshotKey: string | null) {
        const entries = keys
            .map((key) => {
                const tsRaw = parseInt(key.slice(PREFIX.length, -4), 10)
                return { key, size: store.snapshotCost(key, KEY) + pluginBytes(key), ts: Number.isFinite(tsRaw) ? tsRaw : 0 }
            })
            .sort((a, b) => b.ts - a.ts)
        let runningBytes = 0
        const toDelete: string[] = []
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i]
            const isFirst = i === 0
            const fitsByCount = i < maxCount
            const fitsByBytes = runningBytes + e.size <= maxBytes
            if (e.key === restoringSnapshotKey) continue
            if (isFirst || (fitsByCount && fitsByBytes)) {
                runningBytes += e.size
            } else {
                toDelete.push(e.key)
            }
        }
        return toDelete
    }
    // What server.cjs does now.
    function newTrim(store: any, keys: string[], pluginBytes: (key: string) => number, limits: any, protectedKey: string | null) {
        const footprints = store.snapshotCosts(keys, KEY)
        const entries = keys.map((key) => {
            const tsRaw = parseInt(key.slice(PREFIX.length, -4), 10)
            return { key, size: footprints.get(key) + pluginBytes(key), ts: Number.isFinite(tsRaw) ? tsRaw : 0 }
        })
        return selectSnapshotsToTrim(entries, limits, protectedKey)
    }
    function edit(buf: Buffer, rand: () => number, seed: number) {
        const at = Math.floor(rand() * buf.length)
        const r = rand()
        const fresh = seededBytes(1 + Math.floor(rand() * 40_000), seed)
        if (r < 0.4) return Buffer.concat([buf.subarray(0, at), fresh, buf.subarray(at)])
        if (r < 0.7) return Buffer.concat([buf.subarray(0, at), fresh, buf.subarray(Math.min(buf.length, at + fresh.length))])
        return Buffer.concat([buf.subarray(0, at), buf.subarray(Math.min(buf.length, at + Math.floor(rand() * 60_000)))])
    }

    for (let seed = 1; seed <= 30; seed++) {
        it(`sizes every snapshot like snapshotCost and trims the same ones, seed ${seed}`, () => {
            const rand = mulberry32(seed * 7717)
            const db = freshDb()
            const store = createChunkStore(db, { threshold: 2048 })
            // A live blob that keeps changing; snapshots of it along the way
            // share most of their chunks with it and with each other.
            let live = Buffer.concat([seededBytes(100_000 + Math.floor(rand() * 200_000), seed), Buffer.alloc(200_000, 0x41)])
            store.putValue(KEY, live)
            const keys: string[] = []
            let tick = 17_000_000_000 + seed
            const count = 3 + Math.floor(rand() * 18)
            for (let i = 0; i < count; i++) {
                live = edit(live, rand, seed * 100 + i)
                if (rand() < 0.3) {
                    const prev = store.readManifestWithLengths(KEY)
                    store.commitChunks(KEY, editedList({ hashes: prev.hashes, lens: prev.lens, data: [] }, live), prev.hashes)
                } else {
                    store.putValue(KEY, live)
                }
                tick += 1 + Math.floor(rand() * 5000)
                const key = `${PREFIX}${tick}.bin`
                keys.push(key)
                const kind = rand()
                if (kind < 0.7) store.snapshotValue(KEY, key)
                else if (kind < 0.8) store.putValue(key, seededBytes(1 + Math.floor(rand() * 2000), tick)) // stored raw
                else if (kind < 0.85) {
                    // Chunked, then a raw value over it (its manifest not swept).
                    store.putValue(key, edit(live, rand, tick))
                    db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run(key, seededBytes(700, tick))
                } else if (kind < 0.9) {
                    // Listed, but its row is gone.
                } else {
                    // Repeated chunks inside one manifest, some shared with nothing.
                    store.putValue(key, Buffer.concat([Buffer.alloc(300_000, 0x42), seededBytes(90_000, tick), Buffer.alloc(140_000, 0x41)]))
                }
                if (rand() < 0.2) keys.push(key) // a key listed twice
            }
            // Manifests that are not snapshots share chunks too (one of them
            // sorts between the snapshot keys), a chunk may be missing, and
            // the live blob may itself be stored raw.
            store.putValue('archive/abc', edit(live, rand, seed + 5))
            store.putValue(`${PREFIX}${17_000_000_000 + seed + 2}.tmp`, edit(live, rand, seed + 6))
            if (rand() < 0.4) {
                const orphan = store.readManifestWithLengths(keys.find((k) => store.isChunkedKey(k)) ?? KEY).hashes
                db.prepare('DELETE FROM chunks WHERE hash = ?').run(orphan[Math.floor(rand() * orphan.length)])
            }
            if (rand() < 0.15) store.putValue(KEY, seededBytes(1000, seed))

            const costs = store.snapshotCosts(keys, KEY)
            let total = 0
            for (const key of keys) {
                expect(costs.get(key), key).toBe(store.snapshotCost(key, KEY))
                total += costs.get(key)
            }
            expect(total).toBeGreaterThan(0)
            const plugin = new Map(keys.map((k) => [k, rand() < 0.5 ? 0 : Math.floor(rand() * 50_000)]))
            const pluginBytes = (key: string) => plugin.get(key)!
            let deletions = 0
            for (let t = 0; t < 25; t++) {
                const limits = { maxCount: 1 + Math.floor(rand() * (count + 2)), maxBytes: Math.floor(rand() * total * 1.3) }
                const protectedKey = rand() < 0.3 ? keys[Math.floor(rand() * keys.length)] : null
                const expected = oldTrim(store, keys, pluginBytes, limits, protectedKey)
                expect(newTrim(store, keys, pluginBytes, limits, protectedKey)).toEqual(expected)
                deletions += expected.length
            }
            expect(deletions).toBeGreaterThan(0)
        })
    }
})
