'use strict';

// Content-defined chunking for large kv values. Splits an opaque byte buffer
// into content-addressed chunks so a small logical change rewrites only the
// chunks that actually changed (dedup), and so no single SQLite value exceeds
// the BLOB bind limit. Operates purely on bytes — knows nothing about the DB
// schema. See .agent/notes/db-storage-chunking-plan.md.

const crypto = require('crypto');

// Gear table for the rolling hash (FastCDC-style). Deterministic so chunk
// boundaries depend only on content — identical content always cuts the same
// way, which is what makes dedup work across versions.
const GEAR = new Uint32Array(256);
for (let i = 0; i < 256; i++) GEAR[i] = Math.imul(i + 1, 2654435761) >>> 0;

const MIN_SIZE = 4096;        // no boundary checked before this — bounds chunk count
const MAX_SIZE = 65536;       // forced cut here — bounds worst-case chunk size
const MASK = 0x3fff;          // ~16KB average chunk (14 one-bits)

// Split a buffer into ordered content-addressed chunks. Reassembling
// chunks[].data in order reproduces the input exactly.
function cdcSplit(buf) {
    const chunks = [];
    const len = buf.length;
    let start = 0;
    while (start < len) {
        const end = Math.min(start + MAX_SIZE, len);
        let cut = end;
        let h = 0;
        for (let i = Math.min(start + MIN_SIZE, len); i < end; i++) {
            h = ((h << 1) + GEAR[buf[i]]) >>> 0;
            if ((h & MASK) === 0) { cut = i + 1; break; }
        }
        const data = buf.subarray(start, cut);
        const hash = crypto.createHash('sha256').update(data).digest('hex');
        chunks.push({ hash, data });
        start = cut;
    }
    return chunks;
}

module.exports = { cdcSplit };
