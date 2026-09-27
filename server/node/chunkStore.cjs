'use strict';

// Content-defined chunking for large kv values. Splits an opaque byte buffer
// into content-addressed chunks so a small logical change rewrites only the
// chunks that actually changed (dedup), and so no single SQLite value exceeds
// the BLOB bind limit. Operates purely on bytes — knows nothing about the DB
// schema. See .agent/notes/db-storage-chunking-plan.md.
//
// manifest_chunks.seq is an ORDERING key, not an index: a value is its
// chunks in ascending seq order. putValue writes 0..n-1; commitChunks keeps
// the rows of unchanged chunks and gives new rows values between their
// neighbours, so its manifests have gaps. Every reader orders by seq.

const crypto = require('crypto');

// Gear table for the rolling hash (FastCDC-style). Deterministic so chunk
// boundaries depend only on content — identical content always cuts the same
// way, which is what makes dedup work across versions.
const GEAR = new Uint32Array(256);
for (let i = 0; i < 256; i++) GEAR[i] = Math.imul(i + 1, 2654435761) >>> 0;

const MIN_SIZE = 4096;        // no boundary checked before this — bounds chunk count
const MAX_SIZE = 65536;       // forced cut here — bounds worst-case chunk size
const MASK = 0x3fff;          // ~16KB average chunk (14 one-bits)

// Spacing of seq values commitChunks gives rows it numbers itself.
const SEQ_GAP = 1024;

function sha256Hex(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

// Length of the chunk that starts at `start`: the first position at or past
// start + MIN_SIZE where the gear hash (reset at `start`) has its MASK bits
// clear, else a forced cut MAX_SIZE bytes in, else the end of `view`. The
// rule reads only bytes of that chunk, so a caller that holds a window of at
// least MAX_SIZE bytes (or everything up to the end of the data) from
// `start` cuts exactly where cdcSplit cuts the whole buffer.
function chunkLength(view, start) {
    const len = view.length;
    const end = Math.min(start + MAX_SIZE, len);
    let h = 0;
    for (let i = Math.min(start + MIN_SIZE, len); i < end; i++) {
        h = ((h << 1) + GEAR[view[i]]) >>> 0;
        if ((h & MASK) === 0) return i + 1 - start;
    }
    return end - start;
}

// Split a buffer into ordered content-addressed chunks. Reassembling
// chunks[].data in order reproduces the input exactly.
function cdcSplit(buf) {
    const chunks = [];
    const len = buf.length;
    let start = 0;
    while (start < len) {
        const cut = start + chunkLength(buf, start);
        const data = buf.subarray(start, cut);
        chunks.push({ hash: sha256Hex(data), data });
        start = cut;
    }
    return chunks;
}

// Start offset of every chunk, from their lengths.
function chunkStarts(lens) {
    const starts = new Float64Array(lens.length);
    let at = 0;
    for (let i = 0; i < lens.length; i++) {
        starts[i] = at;
        at += lens[i];
    }
    return starts;
}

// Sentinel stored in kv.value for a chunked key. kv.value is NOT NULL, so a
// chunked row holds this marker instead of an empty value; the real bytes live
// in the chunks table, ordered by manifest_chunks. A legacy raw value never
// equals this 13-byte sentinel, so reads stay backward-compatible.
const CHUNK_MARKER = Buffer.from('\x00RISUCHUNKED\x00', 'binary');
const DEFAULT_THRESHOLD = 16 * 1024 * 1024; // values larger than this get chunked

function chunkStoreError(code, message) {
    return Object.assign(new Error(message), { code });
}

// The manifest rows commitChunks writes when it edits a live manifest instead
// of replacing it. Rows of chunks that stay keep their seq; `next.reused[i]`
// names the live row a chunk was copied from, and a new chunk equal to the
// live row after the last kept one is kept as that row as well. Kept rows
// must be increasing in the live order; the chunks between two kept rows get
// evenly spaced seq values strictly between theirs (after the last kept row:
// SEQ_GAP apart). Returns null when some gap is too small: the caller then
// renumbers the whole manifest.
function planManifestEdit(live, next) {
    const n = next.hashes.length;
    const keptOld = new Int32Array(n).fill(-1);
    const kept = new Uint8Array(live.length);
    let last = -1;
    for (let i = 0; i < n; i++) {
        const j = next.reused ? next.reused[i] : -1;
        if (j > last && j < live.length && live[j][1] === next.hashes[i]) {
            keptOld[i] = j;
        } else if (last + 1 < live.length && live[last + 1][1] === next.hashes[i]) {
            keptOld[i] = last + 1;
        } else {
            continue;
        }
        kept[keptOld[i]] = 1;
        last = keptOld[i];
    }
    const seqs = new Array(n);
    for (let i = 0; i < n;) {
        if (keptOld[i] >= 0) {
            seqs[i] = live[keptOld[i]][0];
            i++;
            continue;
        }
        let k = i;
        while (k < n && keptOld[k] < 0) k++;
        const count = k - i;
        const lower = i > 0 ? seqs[i - 1] : -1;
        if (k < n) {
            const upper = live[keptOld[k]][0];
            if (upper - lower - 1 < count) return null;
            for (let t = 0; t < count; t++) seqs[i + t] = lower + Math.floor(((t + 1) * (upper - lower)) / (count + 1));
        } else {
            for (let t = 0; t < count; t++) seqs[i + t] = lower + (t + 1) * SEQ_GAP;
        }
        i = k;
    }
    return { keptOld, kept, seqs };
}

// Bind chunk-aware get/put to a specific better-sqlite3 instance. db.cjs wires
// the real DB; tests wire a :memory: DB. The kv table must already exist (it is
// db.cjs's schema); this creates only the chunk/manifest tables.
function createChunkStore(db, opts = {}) {
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

    db.exec(`
        CREATE TABLE IF NOT EXISTS chunks (
            hash TEXT PRIMARY KEY,
            data BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS manifest_chunks (
            manifest_key TEXT NOT NULL,
            seq          INTEGER NOT NULL,
            hash         TEXT NOT NULL,
            PRIMARY KEY (manifest_key, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_manifest_hash ON manifest_chunks(hash);
    `);

    const insChunk = db.prepare('INSERT OR IGNORE INTO chunks (hash, data) VALUES (?, ?)');
    const delManifest = db.prepare('DELETE FROM manifest_chunks WHERE manifest_key = ?');
    const delManifestRow = db.prepare('DELETE FROM manifest_chunks WHERE manifest_key = ? AND seq = ?');
    const insManifest = db.prepare('INSERT INTO manifest_chunks (manifest_key, seq, hash) VALUES (?, ?, ?)');
    const selManifest = db.prepare('SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq');
    // raw()/pluck() set a statement's mode for good: these three are used only that way.
    const selManifestHashes = db.prepare('SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq').pluck(true);
    const selManifestSeqs = db.prepare('SELECT seq, hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq').raw(true);
    const selManifestLengths = db.prepare(
        `SELECT m.seq, m.hash, LENGTH(c.data) FROM manifest_chunks m LEFT JOIN chunks c ON c.hash = m.hash
         WHERE m.manifest_key = ? ORDER BY m.seq`,
    ).raw(true);
    const selChunk = db.prepare('SELECT data FROM chunks WHERE hash = ?');
    const selSize = db.prepare(
        'SELECT SUM(LENGTH(c.data)) AS n FROM manifest_chunks m JOIN chunks c ON c.hash = m.hash WHERE m.manifest_key = ?',
    );
    // Bytes of chunks referenced by `key` but NOT by `baseKey` — i.e. what `key`
    // uniquely keeps alive beyond the base. Used to size snapshots for the disk
    // limit by their real marginal cost, not their (shared) logical size.
    const selMarginal = db.prepare(
        `SELECT COALESCE(SUM(LENGTH(c.data)), 0) AS n FROM chunks c
         WHERE c.hash IN (SELECT hash FROM manifest_chunks WHERE manifest_key = ?)
           AND c.hash NOT IN (SELECT hash FROM manifest_chunks WHERE manifest_key = ?)`,
    );
    const copyManifest = db.prepare(
        'INSERT INTO manifest_chunks (manifest_key, seq, hash) SELECT ?, seq, hash FROM manifest_chunks WHERE manifest_key = ?',
    );
    const kvSet = db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)');
    const kvGet = db.prepare('SELECT value FROM kv WHERE key = ?');
    const kvDel = db.prepare('DELETE FROM kv WHERE key = ?');
    // Defensive self-heal: drop any manifest that is not backed by a live chunked
    // kv row — i.e. the key is gone OR its value is no longer the marker (some
    // path wrote a raw value over it). Either way the manifest is stale and would
    // pin its chunks forever; sweeping these first lets the damage be reclaimed.
    const gcStaleManifests = db.prepare(
        `DELETE FROM manifest_chunks WHERE NOT EXISTS (
             SELECT 1 FROM kv WHERE kv.key = manifest_chunks.manifest_key AND kv.value = ?)`,
    );
    // Mark-sweep: the set of all hashes referenced by ANY manifest (live + every
    // snapshot/backup) is the live set; anything else is unreachable. Recomputed
    // from manifest_chunks each run — stateless, self-healing, can't over-delete.
    const gcSweep = db.prepare('DELETE FROM chunks WHERE hash NOT IN (SELECT hash FROM manifest_chunks)');
    // Bytes gc would reclaim right now: chunks referenced by no marker-backed
    // (live) manifest. Counts true orphans + chunks held only by stale manifests.
    // The kv check is correlated on key (PK lookup per manifest key, ~6 keys), NOT
    // `value IN (SELECT … WHERE value = ?)` which full-scans every kv blob (seconds
    // on a DB with thousands of assets, blocking the synchronous event loop).
    const selReclaimable = db.prepare(
        `SELECT COALESCE(SUM(LENGTH(data)), 0) AS b FROM chunks WHERE hash NOT IN
         (SELECT hash FROM manifest_chunks mc
          WHERE EXISTS (SELECT 1 FROM kv WHERE kv.key = mc.manifest_key AND kv.value = ?))`,
    );

    const isChunked = (value) => Buffer.isBuffer(value) && value.equals(CHUNK_MARKER);

    // Per-key write generation, in this process: it moves on every write of
    // the key through this store (putValue, snapshotValue onto it, dropValue,
    // commitChunks), also one that failed or was rolled back later. A cache
    // of a value's layout is valid only while the generation it recorded is
    // current. Writes that bypass the store are not seen here; commitChunks
    // checks the live manifest itself before it relies on one.
    let generationCounter = 0;
    const generations = new Map();
    const bump = (key) => { generations.set(key, ++generationCounter); };
    const generation = (key) => generations.get(key) ?? 0;

    // Atomic: clearing the old manifest, inserting new chunks, and writing the
    // marker all commit together. Orphaned chunks from a prior version are left
    // for GC (a later layer) — never deleted here.
    const putValueTx = db.transaction((key, value) => {
        delManifest.run(key);
        if (value.length <= threshold) {
            kvSet.run(key, value, Date.now());
            return;
        }
        const chunks = cdcSplit(value);
        for (const c of chunks) insChunk.run(c.hash, c.data);
        for (let i = 0; i < chunks.length; i++) insManifest.run(key, i, chunks[i].hash);
        kvSet.run(key, CHUNK_MARKER, Date.now());
    });
    function putValue(key, value) {
        try {
            putValueTx(key, value);
        } finally {
            bump(key);
        }
    }

    function getValue(key) {
        const row = kvGet.get(key);
        if (!row) return null;
        if (isChunked(row.value)) {
            const rows = selManifest.all(key);
            // A real chunked key always has manifest rows. If a non-chunked value
            // happens to equal the marker byte-for-byte (astronomically unlikely),
            // there are none — return it raw instead of an empty buffer. No extra
            // cost for real chunked keys: they need this manifest lookup anyway.
            if (rows.length === 0) return row.value;
            return Buffer.concat(rows.map((r) => selChunk.get(r.hash).data));
        }
        return row.value;
    }

    function sizeValue(key) {
        const row = kvGet.get(key);
        if (!row) return null;
        if (isChunked(row.value)) return selSize.get(key).n;
        return row.value.length;
    }

    // Marginal disk cost of a (snapshot) key relative to baseKey (the live blob):
    // raw value → its full length; chunked → bytes of chunks not shared with base.
    // A snapshot identical to base costs ~0; a divergent one costs its real delta.
    function snapshotCost(key, baseKey) {
        const row = kvGet.get(key);
        if (!row) return 0;
        if (!isChunked(row.value)) return row.value.length;
        return selMarginal.get(key, baseKey).n;
    }

    // Copy src's value to dst. For a chunked src, only the manifest (list of
    // chunk hashes) is copied — chunks stay shared, so a snapshot costs ~nothing
    // and never duplicates bytes. Mirrors kvCopyValue: missing src is a no-op.
    const snapshotValueTx = db.transaction((srcKey, dstKey) => {
        const row = kvGet.get(srcKey);
        if (!row) return;
        delManifest.run(dstKey);
        if (isChunked(row.value)) {
            copyManifest.run(dstKey, srcKey);
            kvSet.run(dstKey, CHUNK_MARKER, Date.now());
        } else {
            kvSet.run(dstKey, row.value, Date.now());
        }
    });
    function snapshotValue(srcKey, dstKey) {
        try {
            snapshotValueTx(srcKey, dstKey);
        } finally {
            bump(dstKey);
        }
    }

    // Remove a key entirely (its manifest + kv row). Chunks it referenced
    // become orphans, reclaimed by the next gc(). Used for snapshot rotation.
    const dropValueTx = db.transaction((key) => {
        delManifest.run(key);
        kvDel.run(key);
    });
    function dropValue(key) {
        try {
            dropValueTx(key);
        } finally {
            bump(key);
        }
    }

    // Reclaim unreferenced chunks. Returns the number deleted. Run opportunistically
    // (e.g. Optimize / periodic) — never on the hot save path.
    function gc() {
        gcStaleManifests.run(CHUNK_MARKER);
        return gcSweep.run().changes;
    }

    function reclaimableBytes() {
        return selReclaimable.get(CHUNK_MARKER).b;
    }

    // True only when the key is actually stored chunked right now (its kv value
    // is the marker) — not merely when a manifest exists. A raw value that
    // overwrote the marker (manifest not yet swept) reads as not-chunked.
    function isChunkedKey(key) {
        const row = kvGet.get(key);
        return !!row && isChunked(row.value);
    }

    // The live manifest of `key` in order, with each chunk's length:
    // { seqs, hashes, lens }. Throws MISSING_CHUNK when a row names a chunk
    // the chunks table does not hold.
    function readManifestWithLengths(key) {
        const rows = selManifestLengths.all(key);
        const seqs = new Array(rows.length);
        const hashes = new Array(rows.length);
        const lens = new Array(rows.length);
        for (let i = 0; i < rows.length; i++) {
            const [seq, hash, len] = rows[i];
            if (typeof len !== 'number') throw chunkStoreError('MISSING_CHUNK', `chunk ${i} of ${key} is missing`);
            seqs[i] = seq;
            hashes[i] = hash;
            lens[i] = len;
        }
        return { seqs, hashes, lens };
    }

    // Random access to the bytes of a chunk list ({ hashes, lens, starts? }),
    // e.g. a blob whose manifest was read or written earlier. Chunks are read
    // one statement at a time (no open iterator: this connection is shared)
    // and the last `cacheChunks` are kept.
    function createReader(chunks, { cacheChunks = 32 } = {}) {
        const { hashes, lens } = chunks;
        const starts = chunks.starts ?? chunkStarts(lens);
        const count = hashes.length;
        const total = count > 0 ? starts[count - 1] + lens[count - 1] : 0;
        const cache = new Map();
        let fetched = 0;
        let fetchedBytes = 0;

        function chunkData(j) {
            let data = cache.get(j);
            if (data) {
                cache.delete(j);
                cache.set(j, data);
                return data;
            }
            const row = selChunk.get(hashes[j]);
            if (!row) throw chunkStoreError('MISSING_CHUNK', `chunk ${j} is missing`);
            data = row.data;
            if (data.length !== lens[j]) throw chunkStoreError('CHUNK_LENGTH', `chunk ${j} has ${data.length} bytes, expected ${lens[j]}`);
            fetched++;
            fetchedBytes += data.length;
            cache.set(j, data);
            if (cache.size > cacheChunks) cache.delete(cache.keys().next().value);
            return data;
        }

        // Index of the chunk that holds byte `off`.
        function indexOf(off) {
            let lo = 0;
            let hi = count - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (starts[mid] <= off) lo = mid;
                else hi = mid - 1;
            }
            return lo;
        }

        // Copies [off, off + len) into target at targetOffset.
        function readInto(target, targetOffset, off, len) {
            if (len === 0) return;
            if (off < 0 || off + len > total) throw new RangeError(`read [${off}, ${off + len}) outside ${total} bytes`);
            let j = indexOf(off);
            let pos = off;
            let dst = targetOffset;
            const end = off + len;
            while (pos < end) {
                const data = chunkData(j);
                const from = pos - starts[j];
                const to = Math.min(data.length, end - starts[j]);
                data.copy(target, dst, from, to);
                dst += to - from;
                pos = starts[j] + to;
                j++;
            }
        }

        function read(off, len) {
            if (len > 0 && off >= 0 && off + len <= total) {
                const j = indexOf(off);
                if (off + len <= starts[j] + lens[j]) {
                    const from = off - starts[j];
                    return chunkData(j).subarray(from, from + len);
                }
            }
            const out = Buffer.allocUnsafe(len);
            readInto(out, 0, off, len);
            return out;
        }

        return {
            total,
            read,
            readInto,
            stats: () => ({ fetched, fetchedBytes }),
        };
    }

    // Write `key` as the chunk list `next` ({ hashes, lens, data, reused? }):
    // data[i] is the bytes of a chunk to insert, or null for one the chunks
    // table already holds (a chunk of the live manifest).
    //  - expectedHashes null: the manifest is replaced, rows seq firstSeq,
    //    firstSeq + seqStride, … (0, 1, … by default: what putValue writes).
    //  - expectedHashes given: the live manifest must be exactly that list and
    //    `key` stored chunked, else STALE_LAYOUT and nothing is written. The
    //    manifest is then edited in place (planManifestEdit), renumbered
    //    SEQ_GAP apart when a gap is too small.
    // Before COMMIT the manifest is read back and must be exactly `next`
    // (MANIFEST_READBACK otherwise), then options.verify() runs inside the
    // transaction; anything that throws rolls everything back. BEGIN
    // IMMEDIATE takes the write lock up front, so no other connection can
    // write between the check and the commit.
    const commitChunksTx = db.transaction((key, next, expectedHashes, options) => {
        const n = next.hashes.length;
        if (n === 0 || next.data.length !== n || (next.lens && next.lens.length !== n)) {
            throw chunkStoreError('BAD_CHUNK_LIST', `chunk list for ${key} is empty or inconsistent`);
        }
        let live = null;
        if (expectedHashes) {
            const row = kvGet.get(key);
            if (!row || !isChunked(row.value)) throw chunkStoreError('STALE_LAYOUT', `${key} is not stored chunked`);
            live = selManifestSeqs.all(key);
            if (live.length !== expectedHashes.length) {
                throw chunkStoreError('STALE_LAYOUT', `${key} has ${live.length} chunks, expected ${expectedHashes.length}`);
            }
            for (let i = 0; i < live.length; i++) {
                if (live[i][1] !== expectedHashes[i]) throw chunkStoreError('STALE_LAYOUT', `${key} changed at chunk ${i}`);
            }
        }
        // A chunk that is not inserted must be one the live manifest holds:
        // those rows were just checked, and gc() never deletes a chunk a
        // manifest references, so the new manifest cannot name a missing one.
        const liveHashes = live ? new Set(expectedHashes) : null;
        for (let i = 0; i < n; i++) {
            if (!next.data[i] && !liveHashes?.has(next.hashes[i])) {
                throw chunkStoreError('BAD_CHUNK_LIST', `chunk ${i} of ${key} is neither written nor in the live manifest`);
            }
        }
        let insertedChunks = 0;
        for (let i = 0; i < n; i++) {
            const data = next.data[i];
            if (data) {
                insChunk.run(next.hashes[i], data);
                insertedChunks++;
            }
        }
        const edit = live ? planManifestEdit(live, next) : null;
        let mode;
        let deletedRows = 0;
        let insertedRows = 0;
        if (edit) {
            mode = 'gapped';
            for (let j = 0; j < live.length; j++) {
                if (!edit.kept[j]) {
                    delManifestRow.run(key, live[j][0]);
                    deletedRows++;
                }
            }
            for (let i = 0; i < n; i++) {
                if (edit.keptOld[i] < 0) {
                    insManifest.run(key, edit.seqs[i], next.hashes[i]);
                    insertedRows++;
                }
            }
        } else {
            mode = live ? 'renumber' : 'full';
            const firstSeq = live ? SEQ_GAP : (options.firstSeq ?? 0);
            const stride = live ? SEQ_GAP : (options.seqStride ?? 1);
            deletedRows = delManifest.run(key).changes;
            for (let i = 0; i < n; i++) insManifest.run(key, firstSeq + i * stride, next.hashes[i]);
            insertedRows = n;
        }
        kvSet.run(key, CHUNK_MARKER, Date.now());
        // The manifest IS the value: never commit one that is not exactly the plan.
        const back = selManifestHashes.all(key);
        if (back.length !== n) throw chunkStoreError('MANIFEST_READBACK', `${key} read back ${back.length} chunks, expected ${n}`);
        for (let i = 0; i < n; i++) {
            if (back[i] !== next.hashes[i]) throw chunkStoreError('MANIFEST_READBACK', `${key} read back a different chunk ${i}`);
        }
        if (options.verify) options.verify();
        return { mode, insertedChunks, deletedRows, insertedRows };
    });
    function commitChunks(key, next, expectedHashes = null, options = {}) {
        let result;
        try {
            result = commitChunksTx.immediate(key, next, expectedHashes, options);
        } finally {
            bump(key);
        }
        return { ...result, generation: generation(key) };
    }

    return {
        putValue, getValue, sizeValue, snapshotCost, snapshotValue, dropValue, gc, reclaimableBytes, isChunkedKey,
        generation, readManifestWithLengths, createReader, commitChunks, threshold,
    };
}

module.exports = {
    cdcSplit, chunkLength, chunkStarts, createChunkStore, planManifestEdit, sha256Hex,
    CHUNK_MARKER, MIN_SIZE, MAX_SIZE, SEQ_GAP,
};
