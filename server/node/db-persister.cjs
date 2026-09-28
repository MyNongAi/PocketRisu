'use strict';

// Writer of database/database.bin for the debounced database persist.
//
// The reference path (server.cjs persistDbCacheWithChats) hydrates the whole
// client view (chat bodies merged back, asset manifests expanded), encodes it
// with packr and re-chunks the ~500MB result: 4-6 s of main thread on the
// real data, on every save. The blob is packr.encode of that hydrated
// database, and with { useRecords: false } packr is context-free (see
// msgpack-compose.cjs): a container's bytes are its header followed by its
// children's bytes. This module builds the same bytes from pieces.
//
// persistMode (runtime flag, read by the server per persist):
//  - 'reference': this module is not used.
//  - 'full-plan': every owner (root value, character skeleton, chat, module,
//    persona) is encoded fresh through the reference functions (asset
//    hydration, ChatBodyStore.encodeMerged, packr) into pieces; the whole
//    result is chunked; nothing is remembered between persists.
//  - 'incremental': as full-plan, but an owner that did not change since the
//    last write of this process is a SPAN, copied from the blob on disk at
//    the offset recorded when it was written, and every old chunk that lies
//    inside a span is reused without being read or hashed. The commit edits
//    only the manifest rows that changed. After a cold load, a full write or
//    a persist that left no layout, a background discovery learns the layout
//    of the blob on disk (see "layout discovery" below), so the first
//    persist of a process copies as well.
//
// What makes a span safe (and what is checked):
//  - a layout entry says that an owner's encoding, under the validity tokens
//    below, is the bytes at [off, off + len) of one blob generation. It is
//    recorded when this process writes those bytes, or by discovery, which
//    is read-only and records an owner only where the persist's own encoder,
//    run on the owner under the tokens it then records, produced exactly the
//    bytes the blob holds at that offset (an owner that differs stays out of
//    the layout and is encoded by the next persist);
//  - the layout is valid only for the blob generation it recorded; any other
//    write of the key moves the generation, and commitChunks checks inside
//    its transaction that the live manifest is exactly the one the spans
//    point into (STALE_LAYOUT otherwise);
//  - owners are keyed by object identity (dbCache roots are never mutated in
//    place, see server.cjs); a character additionally needs the same chat
//    body store revision and, for every chat whose body the store holds, the
//    same bodyVersion (the identity of getEncoded's Buffer). A chat of a
//    re-encoded character is reused only when its stub encodes to the same
//    bytes and its bodyVersion is the one recorded;
//  - a character is recorded only when it is complete: every chat with a
//    body was written as the store's own buffer (a no-op merge), none was
//    filled from an archive row, none was written inline;
//  - `written` for a copied chat carries the store's CURRENT buffer, tagged
//    source 'span', which ChatBodyStore.assertPersistComplete re-checks;
//  - every commit is walked (msgpack skip over the root, owner counts, total
//    length, the first and last bytes of every copied run read back from
//    the new manifest) inside the commit transaction, so a failure rolls
//    back;
//  - an idle-time audit re-encodes span owners and compares them with the
//    blob; a mismatch is reported (server: reportCachedRootMutation), which
//    drops the layout and schedules a full rewrite.
// Odd shapes are never refused: a character that is not a plain object is
// hydrated and encoded whole by the reference functions; a root that is not
// a plain object, or root arrays of another class, make prepare() return
// null and the caller uses the reference path for that persist.

const { Packr } = require('msgpackr');
const { magicHeader, releaseEncodeScratch, encodeMsgpackOwned } = require('./utils.cjs');
const { chunkLength, chunkStarts, sha256Hex, MAX_SIZE, SEQ_GAP } = require('./chunkStore.cjs');
const {
    isComposableObject, isComposableArray, forEachOwnKey, mapHeader, arrayHeader, runCanary, buildCanarySample,
} = require('./msgpack-compose.cjs');

const PERSIST_MODES = Object.freeze(['reference', 'full-plan', 'incremental']);
const MAGIC = Buffer.from(magicHeader);
// Same options as utils.cjs (the canary compares the two). msgpackr's encode
// scratch is module-level, shared with utils' packr.
const packr = new Packr({ useRecords: false });
const RELEASE_AFTER_BYTES = 16 * 1024 * 1024;
const FIRST_BLOCK_BYTES = 256 * 1024;
const MAX_BLOCK_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 4;
const TAIL_BYTES = 4;
const ARRAY_KEYS = ['characters', 'modules', 'personas'];

function persisterError(code, message) {
    return Object.assign(new Error(message), { code });
}

function isPersistMode(value) {
    return PERSIST_MODES.includes(value);
}

function chatKey(chaId, chatId) {
    return `${chaId}\u0000${chatId}`;
}

// The chats a bodiless stub can be filled with from an archive row
// (server.cjs lacksArchivedBody).
function lacksArchivedBody(chat) {
    return !!chat && chat._stub === true && !Array.isArray(chat.message);
}

// findStubFlagLossChats' test for one chat of the hydrated database.
function isStubFlagLoss(chat, hasMessageArray) {
    if (!chat || typeof chat !== 'object') return false;
    return chat._stub !== true && !hasMessageArray;
}

// ── pieces ──────────────────────────────────────────────────────────────────
// The new blob as a list of pieces: fresh bytes (copied into arena blocks,
// so consecutive fresh bytes are one contiguous piece) and spans (a range of
// the blob on disk). `origin`: the offset of the first byte written (0 for a
// whole blob; discovery encodes one owner at the offset where the blob must
// hold it, so every offset the encoder records is already absolute).
function createPieceWriter({ origin = 0, firstBlockBytes = FIRST_BLOCK_BYTES } = {}) {
    const pieces = [];
    let block = null;
    let blockUsed = 0;
    let nextBlockBytes = firstBlockBytes;
    let total = origin;
    let freshBytes = 0;
    let spanBytes = 0;
    // The last TAIL_BYTES bytes written, fresh or copied (a span passes the
    // recorded last bytes of what it copies).
    let tail = [];

    function keepTail(src, from) {
        for (let i = Math.max(from, src.length - TAIL_BYTES); i < src.length; i++) tail.push(src[i]);
        if (tail.length > TAIL_BYTES) tail = tail.slice(tail.length - TAIL_BYTES);
    }

    function bytes(src) {
        const len = src.length;
        keepTail(src, 0);
        let from = 0;
        while (from < len) {
            if (!block || blockUsed === block.length) {
                block = Buffer.allocUnsafeSlow(Math.max(nextBlockBytes, Math.min(len - from, MAX_BLOCK_BYTES)));
                blockUsed = 0;
                nextBlockBytes = Math.min(nextBlockBytes * 2, MAX_BLOCK_BYTES);
            }
            const n = Math.min(len - from, block.length - blockUsed);
            block.set(from === 0 && n === len ? src : src.subarray(from, from + n), blockUsed);
            const last = pieces[pieces.length - 1];
            if (last && last.fresh && last.buf === block && last.start + last.len === blockUsed) {
                last.len += n;
            } else {
                pieces.push({ fresh: true, buf: block, start: blockUsed, len: n, at: total });
            }
            blockUsed += n;
            total += n;
            freshBytes += n;
            from += n;
        }
    }

    function span(off, len, tailHex) {
        if (len <= 0) return;
        if (typeof tailHex === 'string') keepTail(Buffer.from(tailHex, 'hex'), 0);
        else tail = [];
        const last = pieces[pieces.length - 1];
        if (last && !last.fresh && last.off + last.len === off) {
            last.len += len;
        } else {
            pieces.push({ fresh: false, off, len, at: total });
        }
        total += len;
        spanBytes += len;
    }

    return {
        pieces,
        bytes,
        span,
        get total() { return total; },
        get freshBytes() { return freshBytes; },
        get spanBytes() { return spanBytes; },
        // The last min(n, TAIL_BYTES) bytes written, as hex.
        tailHex(n) {
            return Buffer.from(tail.slice(Math.max(0, tail.length - Math.min(n, TAIL_BYTES)))).toString('hex');
        },
    };
}

// All bytes of a writer, spans read through `reader` (the blob they copy).
function assemblePieces(w, reader) {
    const out = Buffer.allocUnsafeSlow(w.total);
    for (const p of w.pieces) {
        if (p.fresh) p.buf.copy(out, p.at, p.start, p.start + p.len);
        else reader.readInto(out, p.at, p.off, p.len);
    }
    return out;
}

// ── chunking over pieces ────────────────────────────────────────────────────
function lowerBound(sorted, x) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < x) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// Exactly cdcSplit(concatenation of the pieces), without concatenating:
// cdcSplit's cut depends only on a chunk's own bytes, so where a chunk start
// falls on an old chunk start inside a span, and that old chunk lies wholly
// inside the span (and was not the old blob's last chunk, which EOF may
// have cut, unless it is the last one here too), the old chunk is the next
// chunk: its hash is reused without reading it. Elsewhere the cut is found
// by chunkLength on a window of at most MAX_SIZE bytes gathered from the
// pieces (old bytes through `reader`) and hashed.
function planChunks(w, old, reader) {
    const { pieces } = w;
    const total = w.total;
    const hashes = [];
    const lens = [];
    const data = [];
    const reused = [];
    const stats = { reusedChunks: 0, newChunks: 0, scannedBytes: 0, oldBytesRead: 0 };
    const oldCount = old ? old.hashes.length : 0;
    let pos = 0;
    let pi = 0;

    function gather(start, end) {
        let i = pi;
        const first = pieces[i];
        if (first.fresh && first.at + first.len >= end) {
            const from = first.start + (start - first.at);
            return first.buf.subarray(from, from + (end - start));
        }
        const out = Buffer.allocUnsafe(end - start);
        let p = start;
        while (p < end) {
            const pc = pieces[i];
            const from = p - pc.at;
            const to = Math.min(pc.len, end - pc.at);
            if (pc.fresh) {
                pc.buf.copy(out, p - start, pc.start + from, pc.start + to);
            } else {
                reader.readInto(out, p - start, pc.off + from, to - from);
                stats.oldBytesRead += to - from;
            }
            p = pc.at + to;
            i++;
        }
        return out;
    }

    while (pos < total) {
        while (pieces[pi].at + pieces[pi].len <= pos) pi++;
        const p = pieces[pi];
        if (!p.fresh && oldCount > 0) {
            let oldPos = p.off + (pos - p.at);
            let j = lowerBound(old.starts, oldPos);
            let did = false;
            if (j < oldCount && old.starts[j] === oldPos) {
                while (j < oldCount) {
                    const len = old.lens[j];
                    if (oldPos + len > p.off + p.len) break;
                    if (j === oldCount - 1 && pos + len !== total) break;
                    hashes.push(old.hashes[j]);
                    lens.push(len);
                    data.push(null);
                    reused.push(j);
                    stats.reusedChunks++;
                    pos += len;
                    oldPos += len;
                    j++;
                    did = true;
                }
            }
            if (did) continue;
        }
        const window = gather(pos, Math.min(pos + MAX_SIZE, total));
        const len = chunkLength(window, 0);
        const bytes = window.subarray(0, len);
        hashes.push(sha256Hex(bytes));
        lens.push(len);
        data.push(bytes);
        reused.push(-1);
        stats.newChunks++;
        stats.scannedBytes += len;
        pos += len;
    }
    return { hashes, lens, data, reused, stats };
}

// ── structural walk ─────────────────────────────────────────────────────────
function walkError(message) {
    return persisterError('PERSIST_WALK', `structural check of the new database.bin failed: ${message}`);
}

// Sequential reader of the new blob. Fresh bytes come from the pieces; span
// bytes are read from the committed manifest (readCommitted) only when the
// walk needs them.
function createCursor(pieces, total, readCommitted) {
    let pi = 0;
    let pos = 0;
    let buf = null;
    let local = 0;
    let localEnd = 0;

    function load() {
        if (pos >= total) throw walkError(`value runs past the end (${total} bytes)`);
        while (pieces[pi].at + pieces[pi].len <= pos) pi++;
        const p = pieces[pi];
        const rel = pos - p.at;
        if (p.fresh) {
            buf = p.buf;
            local = p.start + rel;
            localEnd = p.start + p.len;
        } else {
            const n = Math.min(4096, p.len - rel);
            buf = readCommitted(pos, n);
            local = 0;
            localEnd = n;
        }
    }

    return {
        get pos() { return pos; },
        byte() {
            if (local >= localEnd) load();
            pos++;
            return buf[local++];
        },
        peek() {
            if (local >= localEnd) load();
            return buf[local];
        },
        skip(n) {
            pos += n;
            const next = local + n;
            if (next <= localEnd) local = next;
            else local = localEnd = 0;
        },
    };
}

function u16(cur) {
    return (cur.byte() << 8) | cur.byte();
}

function u32(cur) {
    return (cur.byte() * 0x1000000) + ((cur.byte() << 16) | (cur.byte() << 8) | cur.byte());
}

// Skips `count` consecutive msgpack values. A value that starts where a
// copied owner starts (ctx.trusted) is skipped by its recorded length.
function skipValues(cur, count, ctx) {
    let pending = count;
    while (pending > 0) {
        pending--;
        if (ctx.trusted.size > 0) {
            const t = ctx.trusted.get(cur.pos);
            if (t) {
                ctx.skipTrusted(cur, t);
                continue;
            }
        }
        const b = cur.byte();
        if (b <= 0x7f || b >= 0xe0) continue;
        if (b <= 0x8f) { pending += 2 * (b & 0x0f); continue; }
        if (b <= 0x9f) { pending += b & 0x0f; continue; }
        if (b <= 0xbf) { cur.skip(b & 0x1f); continue; }
        switch (b) {
            case 0xc0: case 0xc2: case 0xc3: break;
            case 0xc4: case 0xd9: cur.skip(cur.byte()); break;
            case 0xc5: case 0xda: cur.skip(u16(cur)); break;
            case 0xc6: case 0xdb: cur.skip(u32(cur)); break;
            case 0xc7: { const n = cur.byte(); cur.skip(1 + n); break; }
            case 0xc8: { const n = u16(cur); cur.skip(1 + n); break; }
            case 0xc9: { const n = u32(cur); cur.skip(1 + n); break; }
            case 0xca: cur.skip(4); break;
            case 0xcb: cur.skip(8); break;
            case 0xcc: case 0xd0: cur.skip(1); break;
            case 0xcd: case 0xd1: cur.skip(2); break;
            case 0xce: case 0xd2: cur.skip(4); break;
            case 0xcf: case 0xd3: cur.skip(8); break;
            case 0xd4: cur.skip(2); break;
            case 0xd5: cur.skip(3); break;
            case 0xd6: cur.skip(5); break;
            case 0xd7: cur.skip(9); break;
            case 0xd8: cur.skip(17); break;
            case 0xdc: pending += u16(cur); break;
            case 0xdd: pending += u32(cur); break;
            case 0xde: pending += 2 * u16(cur); break;
            case 0xdf: pending += 2 * u32(cur); break;
            default: throw walkError(`invalid byte 0x${b.toString(16)} at ${cur.pos - 1}`);
        }
    }
}

function readKey(cur) {
    const b = cur.byte();
    let len;
    if (b >= 0xa0 && b <= 0xbf) len = b & 0x1f;
    else if (b === 0xd9) len = cur.byte();
    else if (b === 0xda) len = u16(cur);
    else if (b === 0xdb) len = u32(cur);
    else throw walkError(`root key at ${cur.pos - 1} is not a string`);
    const bytes = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) bytes[i] = cur.byte();
    return bytes.toString('utf8');
}

// Walks the whole new blob: magic header, root map, every value (copied
// owners by their recorded lengths, with their first bytes read back from the
// committed manifest where a copied run starts), and checks the root key
// count, the element counts of characters/modules/personas and the total
// length against the plan.
function walkPlan(plan, readCommitted) {
    const { pieces } = plan.w;
    const total = plan.w.total;
    const spanStarts = new Set();
    const spanEnds = new Set();
    for (const p of pieces) {
        if (p.fresh) continue;
        spanStarts.add(p.at);
        spanEnds.add(p.at + p.len);
    }
    let headChecks = 0;
    let tailChecks = 0;
    const ctx = {
        trusted: plan.trusted,
        // A copied owner is skipped by its recorded length. Where a copied run
        // starts or ends, its first and last bytes in the committed blob must
        // be the ones recorded when the owner was written: a wrong offset or
        // length in the layout shows up there.
        skipTrusted(cur, t) {
            const at = cur.pos;
            const end = at + t.len;
            if (end > total) throw walkError(`copied owner at ${at} runs past the end`);
            if (spanStarts.has(at)) {
                if (readCommitted(at, t.head.length / 2).toString('hex') !== t.head) {
                    throw walkError(`copied bytes at ${at} do not start like the owner recorded there`);
                }
                headChecks++;
            }
            if (spanEnds.has(end)) {
                const n = t.tail.length / 2;
                if (readCommitted(end - n, n).toString('hex') !== t.tail) {
                    throw walkError(`copied bytes ending at ${end} do not end like the owner recorded there`);
                }
                tailChecks++;
            }
            cur.skip(t.len);
        },
    };
    const cur = createCursor(pieces, total, readCommitted);
    for (let i = 0; i < MAGIC.length; i++) {
        if (cur.byte() !== MAGIC[i]) throw walkError('bad magic header');
    }
    if (cur.byte() !== 0xde) throw walkError('the root is not a map16');
    const rootKeys = u16(cur);
    const counts = { characters: -1, modules: -1, personas: -1 };
    const seen = new Set();
    for (let k = 0; k < rootKeys; k++) {
        const key = readKey(cur);
        const at = cur.pos;
        if (ARRAY_KEYS.includes(key) && !seen.has(key) && !(ctx.trusted.size > 0 && ctx.trusted.has(at))) {
            seen.add(key);
            const b = cur.peek();
            if ((b >= 0x90 && b <= 0x9f) || b === 0xdc || b === 0xdd) {
                cur.byte();
                const n = b === 0xdc ? u16(cur) : b === 0xdd ? u32(cur) : b & 0x0f;
                counts[key] = n;
                skipValues(cur, n, ctx);
                continue;
            }
        }
        skipValues(cur, 1, ctx);
    }
    if (cur.pos !== total) throw walkError(`the root ends at ${cur.pos}, the blob at ${total}`);
    if (rootKeys !== plan.counts.rootKeys) throw walkError(`${rootKeys} root keys, expected ${plan.counts.rootKeys}`);
    for (const key of ARRAY_KEYS) {
        if (counts[key] !== plan.counts[key]) throw walkError(`${counts[key]} ${key}, expected ${plan.counts[key]}`);
    }
    if (headChecks !== spanStarts.size) throw walkError(`${spanStarts.size - headChecks} copied run(s) do not start at a recorded owner`);
    if (tailChecks !== spanEnds.size) throw walkError(`${spanEnds.size - tailChecks} copied run(s) do not end at a recorded owner`);
    return { rootKeys, counts, headChecks, tailChecks };
}

// ── the root in msgpackr's order ────────────────────────────────────────────
// The blob as a list of parts: ['bytes', buf] (the magic header, the root map
// header, each root key, the characters/modules/personas array headers),
// ['character', c, index] and ['owner', value, hydration]. The encoder writes
// the parts in order; discovery compares them with the blob in the same
// order. The caller checked the root's shape (rootShapeProblem).
function rootParts(root) {
    const parts = [['bytes', MAGIC]];
    const counts = { rootKeys: 0, characters: -1, modules: -1, personas: -1 };
    const pairs = [];
    forEachOwnKey(root, (key, value) => pairs.push([key, value]));
    counts.rootKeys = pairs.length;
    parts.push(['bytes', mapHeader(pairs.length)]);
    for (const [key, value] of pairs) {
        // packr.encode returns a view of msgpackr's scratch: copied.
        parts.push(['bytes', Buffer.from(packr.encode(key))]);
        if (key === 'characters' && value) {
            // reassembleFullDb maps a truthy characters (prepare checked it
            // is an array), hydrateAssetManifests an array.
            counts.characters = value.length;
            parts.push(['bytes', arrayHeader(value.length)]);
            for (let ci = 0; ci < value.length; ci++) parts.push(['character', value[ci], ci]);
        } else if ((key === 'modules' || key === 'personas') && Array.isArray(value)) {
            counts[key] = value.length;
            parts.push(['bytes', arrayHeader(value.length)]);
            for (let i = 0; i < value.length; i++) parts.push(['owner', value[i], key]);
        } else {
            parts.push(['owner', value, null]);
        }
    }
    return { parts, counts };
}

function rootShapeProblem(root) {
    if (!isComposableObject(root)) return 'root-shape';
    if (root.characters && !isComposableArray(root.characters)) return 'characters-shape';
    for (const key of ['modules', 'personas']) {
        if (Array.isArray(root[key]) && !isComposableArray(root[key])) return `${key}-shape`;
    }
    return null;
}

// ── the persister ───────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {object} deps.blob - db.cjs dbBlob
 * @param {object} deps.chatBodyStore - chat-body-store.cjs instance
 * @param {object} deps.assetManifestStore
 * @param {Function} deps.hydrateAssetManifests - assetManifestMigration.cjs
 * @param {Function} deps.mergeChatStubWithFullChat - chat-body-store.cjs
 * @param {Function} deps.StoredChatBytes - chat-body-store.cjs class
 * @param {Function} deps.hydrateDatabaseForDisk - server.cjs (reference hydration)
 * @param {Function} deps.applyArchivedChatBodies - server.cjs
 * @param {object} [deps.audit] - { getRoot, isIdle, onMismatch, intervalMs, startDelayMs, retryMs, sliceMs, enabled }
 * @param {object} [deps.discovery] - { getRoot (default: audit.getRoot), isEnabled, startDelayMs, sliceMs, manifestPageRows, enabled, defer }
 */
function createDbPersister({
    blob,
    chatBodyStore,
    assetManifestStore,
    hydrateAssetManifests,
    mergeChatStubWithFullChat,
    StoredChatBytes,
    hydrateDatabaseForDisk,
    applyArchivedChatBodies,
    logger = console,
    now = () => performance.now(),
    audit: auditOptions = {},
    discovery: discoveryOptions = {},
}) {
    const canary = checkCanary();
    if (!canary.ok) logger.error(`[Persist] byte composition disabled, every persist uses the reference encoder: ${canary.reason}`);

    let layout = null;
    let incrementalCommitsThisBoot = 0;
    const counters = {
        persists: { 'full-plan': 0, incremental: 0 },
        commits: { full: 0, gapped: 0, renumber: 0, raw: 0 },
        referencePersists: {},
        resets: {},
        walkFailures: 0,
    };
    let last = null;

    function note(map, reason) {
        map[reason] = (map[reason] ?? 0) + 1;
    }

    // packr.encode returns a view of msgpackr's shared scratch: copy it (into
    // the pieces) before the next encode, then hand a large scratch back.
    function afterEncode(view) {
        if (view.length >= RELEASE_AFTER_BYTES) releaseEncodeScratch();
    }

    // The first bytes of an owner's encoding, as hex: the walk reads them
    // back where a copied run starts.
    function headOf(bytes) {
        return Buffer.prototype.toString.call(bytes, 'hex', 0, Math.min(HEAD_BYTES, bytes.length));
    }

    function stubKeyOf(stub) {
        return packr.encode(stub).toString('latin1');
    }

    // ── the encoder ─────────────────────────────────────────────────────────
    // Encodes owners into `w`. base: the layout spans may be copied from
    // (null: everything is encoded fresh). record: build the entries of the
    // next layout. archivedBodies: server.cjs loadArchivedChatBodies result
    // for this persist, or null.
    function createEncoder(w, { base = null, record = false, archivedBodies = null } = {}) {
        const written = [];
        const losses = [];
        const trusted = new Map();
        const entries = record ? new WeakMap() : null;
        const chats = record ? new Map() : null;
        const stats = { freshOwners: 0, spanOwners: 0, freshChats: 0, spanChats: 0, oddOwners: 0 };

        // Encodes `value` whole; returns its length, head and tail.
        function whole(value) {
            const view = packr.encode(value);
            const len = view.length;
            const head = headOf(view);
            w.bytes(view);
            afterEncode(view);
            return { len, head, tail: w.tailHex(len) };
        }

        function copy(entry) {
            const at = w.total;
            w.span(entry.off, entry.len, entry.tail);
            trusted.set(at, { len: entry.len, head: entry.head, tail: entry.tail });
            return at;
        }

        function spanOwner(entry) {
            stats.spanOwners++;
            return copy(entry);
        }

        // Root values (hydration null) and elements of modules/personas.
        function encodeOwner(owner, hydration) {
            if (owner === null || typeof owner !== 'object') {
                whole(owner);
                return;
            }
            const entry = base?.entries.get(owner);
            if (entry && entry.kind === 'owner' && entry.hydration === hydration) {
                const at = spanOwner(entry);
                if (record) entries.set(owner, { ...entry, off: at });
                return;
            }
            const at = w.total;
            const value = hydration
                ? hydrateAssetManifests({ [hydration]: [owner] }, assetManifestStore)[hydration][0]
                : owner;
            const { len, head, tail } = whole(value);
            stats.freshOwners++;
            if (record) entries.set(owner, { kind: 'owner', hydration, off: at, len, head, tail });
        }

        function archivedBodyFor(chaId, chat) {
            if (!archivedBodies || !chaId || !lacksArchivedBody(chat) || !chat.id) return undefined;
            return archivedBodies.get(chaId)?.get(chat.id);
        }

        // Whether a recorded character still encodes to the recorded bytes:
        // same identity (the caller looked it up by identity), and for a
        // character with a chaId the same store revision, the same merge
        // decision, the same body version for every chat that has a body,
        // and no archive row to fill one of its stubs from.
        function characterEntryValid(c, entry) {
            const chaId = c.chaId;
            if (!chaId) return true;
            if (entry.rev !== chatBodyStore.revision(chaId)) return false;
            const mergeable = !!c.chats && chatBodyStore.hasCharacter(chaId);
            if (mergeable !== entry.mergeable) return false;
            const list = c.chats;
            if (!isComposableArray(list)) return !mergeable;
            for (let j = 0; j < list.length; j++) {
                const ch = list[j];
                if (mergeable && ch && ch._stub && ch.id && chatBodyStore.bodyVersion(chaId, ch.id) !== entry.vers[j]) return false;
                if (archivedBodyFor(chaId, ch) !== undefined) return false;
            }
            return true;
        }

        // A character the composer does not take apart: not a plain object,
        // or chats the reference merge cannot map. Hydrated and encoded whole
        // by the reference functions, which also throw where the reference
        // path would.
        function encodeOddCharacter(c, ci) {
            stats.oddOwners++;
            const hydrated = hydrateDatabaseForDisk({ characters: [c] }, { storedBytes: true }).characters[0];
            const list = hydrated?.chats;
            if (list) {
                for (let j = 0; j < list.length; j++) {
                    const chat = list[j];
                    const hasMessage = chat instanceof StoredChatBytes ? chat.hasMessageArray : Array.isArray(chat?.message);
                    if (isStubFlagLoss(chat, hasMessage)) losses.push({ chaId: hydrated.chaId, charIndex: ci, chatIndex: j, chatId: chat.id || null });
                }
            }
            const final = archivedBodies
                ? applyArchivedChatBodies({ characters: [hydrated] }, archivedBodies).db.characters[0]
                : hydrated;
            whole(final);
            const chaId = final?.chaId;
            if (chaId && Array.isArray(final.chats)) {
                for (const chat of final.chats) {
                    if (!chat || typeof chat !== 'object' || Array.isArray(chat) || !chat.id) continue;
                    if (chat instanceof StoredChatBytes) {
                        written.push({ chaId, chatId: chat.id, bytes: chat.body.bytes, source: 'fresh' });
                    } else if (!(chat._stub === true && !Array.isArray(chat.message))) {
                        written.push({ chaId, chatId: chat.id, bytes: encodeMsgpackOwned(chat), source: 'fresh' });
                    }
                }
            }
        }

        function encodeCharacter(c, ci) {
            if (c === null || typeof c !== 'object') {
                whole(c);
                return;
            }
            const chaId = c.chaId;
            const baseEntry = base?.entries.get(c);
            if (baseEntry && baseEntry.kind === 'character' && characterEntryValid(c, baseEntry)) {
                const at = spanOwner(baseEntry);
                for (const r of baseEntry.chats) {
                    written.push({ chaId, chatId: r.id, bytes: chatBodyStore.getEncoded(chaId, r.id), source: 'span' });
                    if (record) chats.set(chatKey(chaId, r.id), { off: at + r.relOff, len: r.len, stubKey: r.stubKey, ver: r.ver, head: r.head, tail: r.tail });
                }
                if (record) entries.set(c, { ...baseEntry, off: at });
                return;
            }
            const mergeable = !!(chaId && c.chats) && chatBodyStore.hasCharacter(chaId);
            if (!isComposableObject(c) || (mergeable && !isComposableArray(c.chats))) {
                encodeOddCharacter(c, ci);
                return;
            }
            // Asset arrays by the reference function (same keys, same order;
            // the chats key keeps its position).
            const skel = hydrateAssetManifests({ characters: [c] }, assetManifestStore).characters[0];
            if (!isComposableObject(skel)) {
                encodeOddCharacter(c, ci);
                return;
            }
            stats.freshOwners++;
            const at = w.total;
            const pairs = [];
            forEachOwnKey(skel, (key, value) => pairs.push([key, value]));
            const header = mapHeader(pairs.length);
            w.bytes(header);
            let head = header.toString('hex');
            let complete = true;
            const vers = [];
            const chatRecs = [];
            for (const [key, value] of pairs) {
                const keyView = packr.encode(key);
                if (head.length < HEAD_BYTES * 2) head += headOf(keyView).slice(0, HEAD_BYTES * 2 - head.length);
                w.bytes(keyView);
                if (key !== 'chats') {
                    whole(value);
                    continue;
                }
                if (!isComposableArray(value)) {
                    // Written as it is; the guard still looks at it.
                    if (value) {
                        complete = false;
                        for (let j = 0; j < value.length; j++) {
                            const chat = value[j];
                            if (isStubFlagLoss(chat, Array.isArray(chat?.message))) {
                                losses.push({ chaId, charIndex: ci, chatIndex: j, chatId: chat.id || null });
                            }
                        }
                    }
                    whole(value);
                    continue;
                }
                w.bytes(arrayHeader(value.length));
                for (let j = 0; j < value.length; j++) {
                    const ch = value[j];
                    const chatAt = w.total;
                    // reassembleFullDb's merge: a stub with an id whose body the store holds.
                    if (mergeable && ch && ch._stub && ch.id) {
                        const ver = chatBodyStore.bodyVersion(chaId, ch.id);
                        vers[j] = ver;
                        if (ver !== undefined) {
                            const key2 = chatKey(chaId, ch.id);
                            const old = base?.chats.get(key2);
                            let stubKey = null;
                            if (old && old.ver === ver) {
                                stubKey = stubKeyOf(ch);
                                if (old.stubKey === stubKey) {
                                    // Recorded only for a no-op merge: the disk bytes are the
                                    // body's own, and neither the body nor the stub changed.
                                    copy(old);
                                    written.push({ chaId, chatId: ch.id, bytes: chatBodyStore.getEncoded(chaId, ch.id), source: 'span' });
                                    stats.spanChats++;
                                    if (record) {
                                        chats.set(key2, { ...old, off: chatAt });
                                        chatRecs.push({ id: ch.id, relOff: chatAt - at, len: old.len, stubKey, ver, head: old.head, tail: old.tail });
                                    }
                                    continue;
                                }
                            }
                            const m = chatBodyStore.encodeMerged(chaId, ch);
                            w.bytes(m.bytes);
                            stats.freshChats++;
                            if (!m.hasMessageArray) losses.push({ chaId, charIndex: ci, chatIndex: j, chatId: ch.id });
                            written.push({ chaId, chatId: ch.id, bytes: m.bytes, source: 'fresh' });
                            if (!m.reused) {
                                complete = false;
                            } else if (record) {
                                stubKey ??= stubKeyOf(ch);
                                const edges = { head: headOf(m.bytes), tail: w.tailHex(m.bytes.length) };
                                chats.set(key2, { off: chatAt, len: m.bytes.length, stubKey, ver, ...edges });
                                chatRecs.push({ id: ch.id, relOff: chatAt - at, len: m.bytes.length, stubKey, ver, ...edges });
                            }
                            continue;
                        }
                    }
                    // applyArchivedChatsForDisk: a bodiless stub filled from an
                    // archive row. The reference guard runs before that, on the
                    // stub, which is not a loss.
                    const archived = archivedBodyFor(chaId, ch);
                    if (archived !== undefined) {
                        const bytes = encodeMsgpackOwned(mergeChatStubWithFullChat(ch, archived));
                        w.bytes(bytes);
                        written.push({ chaId, chatId: ch.id, bytes, source: 'fresh' });
                        complete = false;
                        continue;
                    }
                    // Written as it is: a bodiless stub, or a chat that is not a
                    // stub (inline, hybrid), which the store then holds.
                    const inline = !!chaId && !!ch && typeof ch === 'object' && !Array.isArray(ch) && !!ch.id
                        && !(ch._stub === true && !Array.isArray(ch.message));
                    if (inline) {
                        const bytes = encodeMsgpackOwned(ch);
                        w.bytes(bytes);
                        written.push({ chaId, chatId: ch.id, bytes, source: 'fresh' });
                        complete = false;
                    } else {
                        whole(ch);
                    }
                    if (isStubFlagLoss(ch, Array.isArray(ch?.message))) {
                        losses.push({ chaId, charIndex: ci, chatIndex: j, chatId: ch.id || null });
                    }
                }
            }
            if (record && complete) {
                entries.set(c, {
                    kind: 'character',
                    off: at,
                    len: w.total - at,
                    head,
                    tail: w.tailHex(w.total - at),
                    rev: chaId ? chatBodyStore.revision(chaId) : undefined,
                    mergeable,
                    vers,
                    chats: chatRecs,
                });
            }
        }

        return { written, losses, trusted, entries, chats, stats, encodeOwner, encodeCharacter, characterEntryValid };
    }

    function encodePlan(root, { base, record, archivedBodies }) {
        const w = createPieceWriter();
        const enc = createEncoder(w, { base, record, archivedBodies });
        const { parts, counts } = rootParts(root);
        for (const [kind, value, extra] of parts) {
            if (kind === 'bytes') w.bytes(value);
            else if (kind === 'character') enc.encodeCharacter(value, extra);
            else enc.encodeOwner(value, extra);
        }
        return {
            w,
            written: enc.written,
            losses: enc.losses,
            trusted: enc.trusted,
            entries: enc.entries,
            chats: enc.chats,
            counts,
            stats: { ...enc.stats, freshBytes: w.freshBytes, spanBytes: w.spanBytes, total: w.total },
        };
    }

    /**
     * Plans a persist of `root` (a dbCache root; nothing reachable from it
     * is mutated). Returns null when this persist must take the reference
     * path, which is not an error: a mode other than full-plan/incremental,
     * the canary failed, a root shape the composer does not handle, the chat
     * store is not loaded. Throws what the reference functions throw.
     * The plan carries `losses` (findStubFlagLossChats of the hydrated
     * database, same entries in the same order) and `written` (every chat
     * written with a body) for the caller's guards.
     */
    function prepare(root, { mode, archivedBodies = null } = {}) {
        if (mode !== 'full-plan' && mode !== 'incremental') return null;
        const skip = (reason) => {
            note(counters.referencePersists, reason);
            return null;
        };
        if (!canary.ok) return skip('canary');
        const shape = rootShapeProblem(root);
        if (shape) return skip(shape);
        if (!chatBodyStore.loaded) return skip('store-not-loaded');
        let base = null;
        if (mode !== 'incremental') {
            if (layout) reset('mode');
        } else if (layout) {
            if (layout.generation !== blob.generation()) reset('generation');
            else base = layout;
        }
        const startedAt = now();
        // Before any body is read: acceptPersisted keeps what changes after.
        const token = chatBodyStore.snapshotToken();
        const plan = encodePlan(root, { base, record: mode === 'incremental', archivedBodies });
        return {
            mode,
            base,
            token,
            plan,
            // Held for the layout's rootRef only.
            rootRef: new WeakRef(root),
            written: plan.written,
            losses: plan.losses,
            startedAt,
            encodeMs: now() - startedAt,
        };
    }

    /**
     * Writes a prepared plan. `beforeFirstIncremental({ hashes })` runs
     * before the first commit of this process that copies from the old blob
     * (again after a commit that failed); `hashes` is that blob's chunk list
     * (the server makes sure a snapshot of exactly that blob exists: the
     * newest one, or a forced one). On any throw nothing was committed
     * (STALE_LAYOUT, MANIFEST_READBACK, PERSIST_WALK, BAD_CHUNK_LIST, SQLite
     * errors, a failed snapshot) and the layout is dropped; the caller then
     * writes with the reference path.
     */
    function commit(prepared, { beforeFirstIncremental = null } = {}) {
        try {
            return commitPlan(prepared, beforeFirstIncremental);
        } catch (error) {
            if (error?.code === 'PERSIST_WALK') counters.walkFailures++;
            reset(error?.code ? String(error.code).toLowerCase() : 'commit-error');
            throw error;
        }
    }

    function commitPlan(prepared, beforeFirstIncremental) {
        const { plan, base, mode } = prepared;
        const w = plan.w;
        const t0 = now();
        const oldReader = base ? blob.createReader(base.chunks) : null;
        if (w.total <= blob.threshold) {
            // Stored raw, as kvSet stores a value this small. Walked before
            // the write: a failure writes nothing.
            const bytes = assemblePieces(w, oldReader);
            const whole = {
                w: { pieces: [{ fresh: true, buf: bytes, start: 0, len: bytes.length, at: 0 }], total: bytes.length },
                trusted: new Map(),
                counts: plan.counts,
            };
            const tw = now();
            walkPlan(whole, () => { throw walkError('a raw blob has no copied bytes'); });
            const walkMs = now() - tw;
            blob.putValue(bytes);
            layout = null;
            counters.commits.raw++;
            counters.persists[mode]++;
            last = finishStats(prepared, { commit: 'raw', walkMs, commitMs: now() - tw - walkMs }, t0);
            return { written: plan.written, stats: last };
        }
        const chunks = planChunks(w, base ? base.chunks : null, oldReader);
        const t1 = now();
        // hashes: the chunk list of the blob this commit edits (commitChunks
        // checks the live manifest is exactly that list before it writes).
        if (base && incrementalCommitsThisBoot === 0 && beforeFirstIncremental) beforeFirstIncremental({ hashes: base.chunks.hashes });
        const t2 = now();
        let walkMs = 0;
        const result = blob.commitChunks(
            { hashes: chunks.hashes, lens: chunks.lens, data: chunks.data, reused: chunks.reused },
            base ? base.chunks.hashes : null,
            {
                // full-plan writes the rows putValue writes (0, 1, …);
                // incremental leaves room for in-place edits.
                firstSeq: mode === 'incremental' ? SEQ_GAP : 0,
                seqStride: mode === 'incremental' ? SEQ_GAP : 1,
                // Inside the transaction, after the read-back: a walk that
                // fails rolls the whole commit back.
                verify() {
                    const tw = now();
                    const reader = blob.createReader({ hashes: chunks.hashes, lens: chunks.lens });
                    walkPlan(plan, (off, len) => reader.read(off, len));
                    walkMs = now() - tw;
                },
            },
        );
        const t3 = now();
        layout = mode === 'incremental'
            ? {
                generation: result.generation,
                chunks: { hashes: chunks.hashes, lens: chunks.lens, starts: chunkStarts(chunks.lens) },
                entries: plan.entries,
                chats: plan.chats,
                total: w.total,
                rootRef: prepared.rootRef,
            }
            : null;
        if (base) incrementalCommitsThisBoot++;
        counters.commits[result.mode]++;
        counters.persists[mode]++;
        last = finishStats(prepared, {
            commit: result.mode,
            chunkMs: t1 - t0,
            snapshotMs: t2 - t1,
            walkMs,
            commitMs: t3 - t2 - walkMs,
            ...chunks.stats,
            insertedChunks: result.insertedChunks,
            deletedRows: result.deletedRows,
            insertedRows: result.insertedRows,
        }, t0);
        if (layout) scheduleAudit();
        return { written: plan.written, stats: last };
    }

    function round(ms) {
        return Math.round(ms * 10) / 10;
    }

    function finishStats(prepared, extra, commitStartedAt) {
        const out = { persistMode: prepared.mode, spans: !!prepared.base, encodeMs: round(prepared.encodeMs) };
        for (const [key, value] of Object.entries(extra)) out[key] = key.endsWith('Ms') ? round(value) : value;
        out.commitPhaseMs = round(now() - commitStartedAt);
        out.totalMs = round(now() - prepared.startedAt);
        return { ...out, ...prepared.plan.stats };
    }

    function reset(reason = 'reset') {
        if (layout) note(counters.resets, reason);
        layout = null;
        auditState.position = null;
        cancelDiscovery(reason);
    }

    // ── the idle audit (incremental mode) ───────────────────────────────────
    // Re-encodes every owner and chat the layout would copy and compares it
    // with its bytes in the blob. Runs in slices while the server is idle,
    // at most one pass per intervalMs, and only after incremental commits.
    const auditConfig = {
        getRoot: auditOptions.getRoot ?? (() => null),
        isIdle: auditOptions.isIdle ?? (() => true),
        onMismatch: auditOptions.onMismatch ?? (() => {}),
        intervalMs: auditOptions.intervalMs ?? 10 * 60 * 1000,
        startDelayMs: auditOptions.startDelayMs ?? 3000,
        retryMs: auditOptions.retryMs ?? 1000,
        sliceMs: auditOptions.sliceMs ?? 10,
        enabled: auditOptions.enabled ?? true,
    };
    const auditState = {
        timer: null,
        position: null, // { items, index }
        due: false,
        lastPassAt: -Infinity,
        passes: 0,
        checkedOwners: 0,
        checkedChats: 0,
        mismatches: 0,
        lastMismatch: null,
    };

    function scheduleAudit() {
        auditState.due = true;
        armAudit(auditConfig.startDelayMs);
    }

    function armAudit(delay) {
        if (!auditConfig.enabled || auditState.timer) return;
        auditState.timer = setTimeout(auditTick, Math.max(0, delay));
        auditState.timer.unref?.();
    }

    function auditTick() {
        auditState.timer = null;
        if (!layout) {
            auditState.position = null;
            return;
        }
        if (!auditState.position) {
            if (!auditState.due) return;
            const wait = auditState.lastPassAt + auditConfig.intervalMs - Date.now();
            if (wait > 0) {
                armAudit(wait);
                return;
            }
        }
        if (!auditConfig.isIdle()) {
            armAudit(auditConfig.retryMs);
            return;
        }
        let done;
        try {
            done = runAuditSlice(auditConfig.sliceMs);
        } catch (error) {
            logger.warn(`[Persist] audit step failed, dropping the layout: ${error?.message || error}`);
            reset('audit-error');
            return;
        }
        if (!done) armAudit(0);
    }

    function auditItems(root) {
        const items = [];
        if (isComposableObject(root)) {
            forEachOwnKey(root, (key, value) => {
                if (key === 'characters' && isComposableArray(value)) {
                    for (let i = 0; i < value.length; i++) items.push(['character', value[i], i]);
                } else if ((key === 'modules' || key === 'personas') && isComposableArray(value)) {
                    for (let i = 0; i < value.length; i++) items.push(['owner', value[i], key]);
                } else if (value !== null && typeof value === 'object') {
                    items.push(['owner', value, null]);
                }
            });
        }
        if (layout) for (const key of layout.chats.keys()) items.push(['chat', key, null]);
        return items;
    }

    // One slice of the current pass; true when the pass ended (complete, a
    // mismatch, or abandoned because the layout went away).
    function runAuditSlice(budgetMs) {
        const started = now();
        if (!auditState.position) {
            auditState.position = { items: auditItems(auditConfig.getRoot()), index: 0 };
            auditState.due = false;
        }
        const pos = auditState.position;
        while (pos.index < pos.items.length) {
            if (!layout) {
                auditState.position = null;
                return true;
            }
            if (layout.generation !== blob.generation()) {
                // Another writer: the next persist drops this layout anyway.
                reset('generation');
                return true;
            }
            const [kind, value, extra] = pos.items[pos.index++];
            const mismatch = kind === 'chat' ? auditChat(value) : auditOwner(kind, value, extra);
            if (mismatch) {
                auditState.mismatches++;
                auditState.lastMismatch = { ...mismatch, at: Date.now() };
                reset('audit-mismatch');
                auditConfig.onMismatch(mismatch);
                return true;
            }
            if (now() - started >= budgetMs) return false;
        }
        auditState.position = null;
        auditState.passes++;
        auditState.lastPassAt = Date.now();
        return true;
    }

    function blobReader() {
        return blob.createReader(layout.chunks, { cacheChunks: 8 });
    }

    function auditOwner(kind, value, extra) {
        if (value === null || typeof value !== 'object') return null;
        const entry = layout.entries.get(value);
        if (!entry) return null;
        const w = createPieceWriter();
        const enc = createEncoder(w);
        if (kind === 'character') {
            if (entry.kind !== 'character' || !enc.characterEntryValid(value, entry)) return null;
            enc.encodeCharacter(value, extra);
        } else {
            if (entry.kind !== 'owner' || entry.hydration !== extra) return null;
            enc.encodeOwner(value, extra);
        }
        auditState.checkedOwners++;
        const canonical = assemblePieces(w, null);
        if (canonical.length === entry.len && canonical.equals(blobReader().read(entry.off, entry.len))) return null;
        return {
            owner: kind === 'character' ? 'character' : (extra ?? 'root value'),
            index: kind === 'character' ? extra : null,
            off: entry.off,
            len: entry.len,
        };
    }

    function auditChat(key) {
        const ce = layout.chats.get(key);
        if (!ce) return null;
        const sep = key.indexOf('\u0000');
        const chaId = key.slice(0, sep);
        const chatId = key.slice(sep + 1);
        if (chatBodyStore.bodyVersion(chaId, chatId) !== ce.ver) return null;
        const bytes = chatBodyStore.getEncoded(chaId, chatId);
        auditState.checkedChats++;
        if (bytes.length === ce.len && bytes.equals(blobReader().read(ce.off, ce.len))) return null;
        return { owner: 'chat', index: null, off: ce.off, len: ce.len };
    }

    // ── layout discovery (incremental mode) ─────────────────────────────────
    // A layout only knows what this process wrote, so after a cold load, a
    // full write (/api/write) or a persist that left none, the first
    // incremental persist would encode everything (~4 s on the real data).
    // Discovery learns the layout of the blob on disk instead, READ-ONLY:
    // it encodes the root's parts in order with the persist's own encoder
    // (rootParts, createEncoder with record) and compares each with the
    // blob at the offset where the part must start, through a chunk reader.
    //  - An owner whose bytes are equal becomes a layout entry, with the chat
    //    entries of its no-op merges, exactly as a persist that wrote those
    //    bytes would have recorded them (same validity tokens, taken in the
    //    same synchronous step as the comparison).
    //  - An owner that differs (the blob is not canonical for it) is skipped
    //    over in the blob (msgpack skip) and stays unverified: a persist
    //    encodes it.
    //  - A header or root key that differs ends the walk; what was verified
    //    before it stays.
    // It pins the root it started from and the blob generation, reads the
    // manifest in pages and walks in slices of sliceMs (one owner can take
    // longer) with setImmediate between them, holding no SQLite iterator
    // across. The partial layout is installed once the manifest is read, so
    // a persist during discovery copies the owners verified so far and
    // encodes the rest; its commit installs a complete layout, which ends
    // the run. So does another generation (any write of the blob), a reset,
    // or isEnabled() turning false (the server: persistMode is no longer
    // 'incremental'). The server schedules it only in incremental mode.
    const discoveryConfig = {
        getRoot: discoveryOptions.getRoot ?? auditConfig.getRoot,
        isEnabled: discoveryOptions.isEnabled ?? (() => true),
        startDelayMs: discoveryOptions.startDelayMs ?? 2000,
        sliceMs: discoveryOptions.sliceMs ?? 8,
        manifestPageRows: discoveryOptions.manifestPageRows ?? 2048,
        enabled: discoveryOptions.enabled ?? true,
        // Runs fn on a later turn of the event loop; returns a cancel function.
        // Not unref'd: an unref'd immediate does not keep the event loop from
        // blocking in its poll phase, so on an idle server every slice waited
        // for some unrelated timer or I/O (about 1 s each; a real discovery
        // took over two minutes of wall time for 1.6 s of work).
        defer: discoveryOptions.defer ?? ((fn) => {
            const handle = setImmediate(fn);
            return () => clearImmediate(handle);
        }),
    };
    const DISCOVERY_FIRST_BLOCK_BYTES = 16 * 1024;
    // skipValues' context for a walk over the blob alone (no copied owners).
    const NOTHING_TRUSTED = { trusted: new Map(), skipTrusted() {} };
    const discoveryState = {
        timer: null,
        cancelNext: null,
        run: null,
        runs: 0,
        completed: 0,
        skipped: {},
        ended: {},
        last: null,
    };

    // (Re)starts discovery startDelayMs from now. Returns false when it is
    // off (disabled, or the canary failed: every persist is a reference one).
    function scheduleDiscovery(reason = 'schedule') {
        cancelDiscovery('rescheduled');
        if (!discoveryConfig.enabled || !canary.ok) return false;
        discoveryState.timer = setTimeout(() => {
            discoveryState.timer = null;
            if (beginDiscovery(reason)) armDiscovery();
        }, Math.max(0, discoveryConfig.startDelayMs));
        discoveryState.timer.unref?.();
        return true;
    }

    function armDiscovery() {
        discoveryState.cancelNext = discoveryConfig.defer(() => {
            discoveryState.cancelNext = null;
            const run = discoveryState.run;
            if (run && !runDiscoverySlice(run, discoveryConfig.sliceMs)) armDiscovery();
        });
    }

    function cancelDiscovery(reason) {
        if (discoveryState.timer) clearTimeout(discoveryState.timer);
        if (discoveryState.cancelNext) discoveryState.cancelNext();
        discoveryState.timer = null;
        discoveryState.cancelNext = null;
        if (discoveryState.run) endDiscovery(discoveryState.run, reason);
    }

    // A new run over the current root and blob, or null when there is
    // nothing to discover.
    function beginDiscovery(reason) {
        const skip = (why) => {
            note(discoveryState.skipped, why);
            return null;
        };
        if (!discoveryConfig.isEnabled()) return skip('disabled');
        const root = discoveryConfig.getRoot();
        if (!root) return skip('no-root');
        if (rootShapeProblem(root)) return skip('root-shape');
        if (!chatBodyStore.loaded) return skip('store-not-loaded');
        if (!blob.isChunked()) return skip('not-chunked');
        const generation = blob.generation();
        // A layout of this blob built from this root: nothing to learn. One
        // built from another root (a cold load after a guard dropped the
        // root, same blob) knows none of this root's objects.
        if (layout && layout.generation === generation && layout.rootRef?.deref() === root) return skip('has-layout');
        discoveryState.runs++;
        discoveryState.run = {
            reason,
            root,
            generation,
            parts: rootParts(root).parts,
            index: 0,
            off: 0,
            manifest: { afterSeq: Number.MIN_SAFE_INTEGER, hashes: [], lens: [] },
            layout: null,
            reader: null,
            startedAt: now(),
            stats: {
                owners: 0,
                verifiedOwners: 0,
                mismatchedOwners: 0,
                failedOwners: 0,
                entries: 0,
                chats: 0,
                verifiedBytes: 0,
                slices: 0,
                cpuMs: 0,
                maxSliceMs: 0,
                maxOwnerMs: 0,
                manifestMs: 0,
            },
        };
        return discoveryState.run;
    }

    // Why `run` cannot go on, or null.
    function discoveryStop(run) {
        if (discoveryState.run !== run) return 'superseded';
        if (!discoveryConfig.isEnabled()) return 'disabled';
        if (run.layout && layout !== run.layout) return 'superseded';
        if (blob.generation() !== run.generation) return 'generation';
        return null;
    }

    // One slice; true when the run ended.
    function runDiscoverySlice(run, budgetMs) {
        const started = now();
        let ended;
        try {
            ended = discoverySteps(run, started, budgetMs);
        } catch (error) {
            logger.warn(`[Persist] layout discovery stopped: ${error?.message || error}`);
            ended = endDiscovery(run, 'error');
        }
        const ms = now() - started;
        run.stats.slices++;
        run.stats.cpuMs += ms;
        if (ms > run.stats.maxSliceMs) run.stats.maxSliceMs = ms;
        // endDiscovery ran in this slice: count the slice in.
        if (ended) {
            const d = discoveryState.last = publicDiscoveryStats(run);
            // Counts and timings only; the live machine reads this from stdout.
            logger.debug(`[Layout] database/database.bin discovery ${d.stopped} (${d.reason}): `
                + `${d.verifiedOwners}/${d.owners} owners, ${d.chats} chats, ${d.mismatchedOwners} mismatched, `
                + `cpu ${Math.round(d.cpuMs)} ms in ${d.slices} slices (max ${Math.round(d.maxSliceMs)} ms), wall ${Math.round(d.wallMs)} ms`);
        }
        return ended;
    }

    function discoverySteps(run, started, budgetMs) {
        const stop = discoveryStop(run);
        if (stop) return endDiscovery(run, stop);
        if (!run.layout) {
            const t0 = now();
            const done = readManifestPages(run, started, budgetMs);
            run.stats.manifestMs += now() - t0;
            if (!done) return false;
            installDiscoveredLayout(run);
            if (now() - started >= budgetMs) return false;
        }
        const parts = run.parts;
        while (run.index < parts.length) {
            const [kind, value, extra] = parts[run.index];
            if (kind === 'bytes') {
                if (!blobMatches(run, run.off, value, 0, value.length)) return endDiscovery(run, 'structure');
                run.off += value.length;
                run.index++;
                continue;
            }
            discoverOwner(run, kind, value, extra);
            run.index++;
            if (now() - started >= budgetMs) return false;
        }
        return endDiscovery(run, run.off === run.layout.total ? 'complete' : 'length');
    }

    // Reads manifest pages until the manifest is complete (true) or the
    // budget is spent (false).
    function readManifestPages(run, started, budgetMs) {
        const m = run.manifest;
        for (;;) {
            const page = blob.readManifestPage(m.afterSeq, discoveryConfig.manifestPageRows);
            for (let i = 0; i < page.hashes.length; i++) {
                m.hashes.push(page.hashes[i]);
                m.lens.push(page.lens[i]);
            }
            if (page.hashes.length < discoveryConfig.manifestPageRows) return true;
            m.afterSeq = page.seqs[page.seqs.length - 1];
            if (now() - started >= budgetMs) return false;
        }
    }

    function installDiscoveredLayout(run) {
        const { hashes, lens } = run.manifest;
        const starts = chunkStarts(lens);
        const total = lens.length > 0 ? starts[lens.length - 1] + lens[lens.length - 1] : 0;
        run.layout = {
            generation: run.generation,
            chunks: { hashes, lens, starts },
            entries: new WeakMap(),
            chats: new Map(),
            total,
            rootRef: new WeakRef(run.root),
            discovered: true,
            partial: true,
        };
        run.manifest = null;
        run.reader = blob.createReader(run.layout.chunks, { cacheChunks: 8 });
        layout = run.layout;
        auditState.position = null;
    }

    // Encodes one owner at the offset where the blob must hold it and
    // compares; records it when equal, skips the blob's value otherwise.
    function discoverOwner(run, kind, value, extra) {
        const t0 = now();
        const at = run.off;
        const stats = run.stats;
        const w = createPieceWriter({ origin: at, firstBlockBytes: DISCOVERY_FIRST_BLOCK_BYTES });
        const enc = createEncoder(w, { record: true });
        stats.owners++;
        let equal = true;
        try {
            if (kind === 'character') enc.encodeCharacter(value, extra);
            else enc.encodeOwner(value, extra);
        } catch {
            // What the reference functions throw for this owner; a persist
            // throws there too. Unverified.
            equal = false;
            stats.failedOwners++;
        }
        equal = equal && w.total <= run.layout.total;
        for (let i = 0; equal && i < w.pieces.length; i++) {
            const p = w.pieces[i];
            equal = blobMatches(run, p.at, p.buf, p.start, p.len);
        }
        if (equal) {
            const entry = value !== null && typeof value === 'object' ? enc.entries.get(value) : undefined;
            if (entry) {
                run.layout.entries.set(value, entry);
                stats.entries++;
            }
            for (const [key, ce] of enc.chats) run.layout.chats.set(key, ce);
            stats.chats += enc.chats.size;
            stats.verifiedOwners++;
            stats.verifiedBytes += w.total - at;
            run.off = w.total;
        } else {
            stats.mismatchedOwners++;
            run.off = skipBlobValue(run, at);
        }
        const ms = now() - t0;
        if (ms > stats.maxOwnerMs) stats.maxOwnerMs = ms;
    }

    // Whether the blob holds buf[start, start + len) at offset `at`, compared
    // chunk by chunk (views of the reader's cached chunks, no copies).
    function blobMatches(run, at, buf, start, len) {
        const { starts, lens } = run.layout.chunks;
        if (at + len > run.layout.total) return false;
        let pos = at;
        let from = start;
        const end = at + len;
        let j = lowerBound(starts, at + 1) - 1;
        while (pos < end) {
            const n = Math.min(end, starts[j] + lens[j]) - pos;
            const data = run.reader.read(pos, n);
            if (buf.compare(data, 0, n, from, from + n) !== 0) return false;
            pos += n;
            from += n;
            j++;
        }
        return true;
    }

    // The end of the msgpack value that starts at `at` in the blob.
    function skipBlobValue(run, at) {
        const total = run.layout.total;
        const cur = createCursor([{ fresh: false, off: 0, len: total, at: 0 }], total, (pos, n) => run.reader.read(pos, n));
        cur.skip(at);
        skipValues(cur, 1, NOTHING_TRUSTED);
        return cur.pos;
    }

    function endDiscovery(run, stopped) {
        if (discoveryState.run === run) discoveryState.run = null;
        note(discoveryState.ended, stopped);
        // A walk that reached its end, or stopped at a header or a length
        // that differs, leaves its layout (every entry in it was verified).
        // A run cut short (another generation, a reset, a new run, an error,
        // the mode switched) drops its partial layout if it is still the
        // installed one.
        if (stopped === 'complete') run.layout.partial = false;
        else if (stopped !== 'structure' && stopped !== 'length' && run.layout && layout === run.layout) layout = null;
        if (stopped === 'complete') discoveryState.completed++;
        run.stopped = stopped;
        run.reader = null;
        run.parts = null;
        run.root = null;
        discoveryState.last = publicDiscoveryStats(run);
        return true;
    }

    function publicDiscoveryStats(run) {
        const s = run.stats;
        return {
            reason: run.reason,
            stopped: run.stopped ?? null,
            owners: s.owners,
            verifiedOwners: s.verifiedOwners,
            mismatchedOwners: s.mismatchedOwners,
            failedOwners: s.failedOwners,
            entries: s.entries,
            chats: s.chats,
            verifiedBytes: s.verifiedBytes,
            slices: s.slices,
            cpuMs: round(s.cpuMs),
            maxSliceMs: round(s.maxSliceMs),
            maxOwnerMs: round(s.maxOwnerMs),
            manifestMs: round(s.manifestMs),
            wallMs: round(now() - run.startedAt),
        };
    }

    // Runs a whole discovery now, in one call (tests, diagnostics). Returns
    // its stats, or null when there was nothing to discover.
    function discoverNow(reason = 'now') {
        cancelDiscovery('rescheduled');
        const run = beginDiscovery(reason);
        if (!run) return null;
        runDiscoverySlice(run, Infinity);
        return { ...discoveryState.last };
    }

    function stats() {
        return {
            canary: canary.ok ? 'ok' : canary.reason,
            layout: layout
                ? {
                    generation: layout.generation,
                    chunks: layout.chunks.hashes.length,
                    bytes: layout.total,
                    chats: layout.chats.size,
                    discovered: !!layout.discovered,
                    partial: !!layout.partial,
                }
                : null,
            incrementalCommitsThisBoot,
            ...counters,
            last,
            audit: {
                passes: auditState.passes,
                running: !!auditState.position,
                lastPassAt: Number.isFinite(auditState.lastPassAt) ? auditState.lastPassAt : null,
                checkedOwners: auditState.checkedOwners,
                checkedChats: auditState.checkedChats,
                mismatches: auditState.mismatches,
                lastMismatch: auditState.lastMismatch,
            },
            discovery: {
                runs: discoveryState.runs,
                completed: discoveryState.completed,
                running: !!discoveryState.run,
                scheduled: !!discoveryState.timer,
                current: discoveryState.run ? publicDiscoveryStats(discoveryState.run) : null,
                skipped: { ...discoveryState.skipped },
                ended: { ...discoveryState.ended },
                last: discoveryState.last,
            },
        };
    }

    // Runs a whole audit pass now, ignoring idle and the interval (tests,
    // diagnostics).
    function auditNow() {
        if (!layout) return { ran: false, mismatches: 0 };
        auditState.position = null;
        const before = auditState.mismatches;
        runAuditSlice(Infinity);
        return { ran: true, mismatches: auditState.mismatches - before };
    }

    function stop() {
        if (auditState.timer) clearTimeout(auditState.timer);
        auditState.timer = null;
        cancelDiscovery('stop');
    }

    return {
        prepare,
        commit,
        reset,
        stats,
        auditNow,
        scheduleDiscovery,
        discoverNow,
        stop,
        hasLayout: () => !!layout,
        _layout: () => layout,
    };
}

// The rules the composer relies on, checked against the installed msgpackr:
// msgpack-compose's canary, and this module's Packr against utils.cjs's.
function checkCanary() {
    const composed = runCanary();
    if (!composed.ok) return composed;
    try {
        const sample = buildCanarySample();
        const mine = Buffer.from(packr.encode(sample));
        const theirs = encodeMsgpackOwned(sample);
        if (!mine.equals(theirs)) return { ok: false, reason: 'the persister Packr encodes differently from utils.cjs' };
    } catch (error) {
        return { ok: false, reason: `canary threw: ${error?.message ?? error}` };
    }
    return { ok: true };
}

module.exports = {
    createDbPersister,
    isPersistMode,
    PERSIST_MODES,
    // Exposed for tests.
    createPieceWriter,
    planChunks,
    walkPlan,
    assemblePieces,
};
