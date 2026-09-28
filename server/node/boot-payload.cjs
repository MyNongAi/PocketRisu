'use strict';

// The database.bin payload of GET /api/read (MAGIC ‖ packr.encode(root) of
// the client view) as a list of content-addressed segments, and the framing
// of POST /api/db/boot built on them.
//
// With the rules in msgpack-compose.cjs the payload of a root is
//     prefix ‖ seg_0 ‖ seg_1 ‖ … ‖ seg_n-1
//     prefix = MAGIC ‖ mapHeader(keyCount)
// with one segment enc(key) ‖ enc(value) per root key, except for a split
// key (an array: `characters` and `modules` always, another array of large
// objects by SPLIT_MIN_*), which is a head segment enc(key) ‖ arrayHeader(n)
// followed by one segment enc(element) per element. A root that msgpackr
// does not write as a plain object is one segment, encoded whole.
//
// Every segment has a digest (sha256, the first 16 bytes) and a length. They
// are memoized on the objects the bytes come from, in WeakMaps: installed
// dbCache roots are never changed in place and a patch hands every untouched
// characters[i] / modules[i] to the next root as the same object (see
// server.cjs), so planning a new root encodes only what is new in it. The
// planner keeps no payload bytes: a segment is encoded again when it is
// served, and its digest is checked then (a mismatch means something changed
// a cached object in place; the planner then disables itself).
//
// The plan's etag, `m1-` and 40 hex digits of
//     sha256(0x01 ‖ prefix ‖ Σ(digest ‖ u32be(len)))
// is the database etag (x-db-etag) while the planner is enabled. A client of
// /api/db/boot recomputes it from the manifest it receives.
//
// Before the planner serves anything, a self-test compares the plan of a
// real root with a whole encode of that root; a mismatch disables it, and
// the server goes back to encoding the whole view (md5 etags).

const nodeCrypto = require('crypto');
const { magicHeader, encodeMsgpackOwned, encodeRisuSaveLegacyBuffer, releaseEncodeScratch } = require('./utils.cjs');
const {
    isComposableObject, isComposableArray, forEachOwnKey, mapHeader, arrayHeader, runCanary,
} = require('./msgpack-compose.cjs');

const PLAN_VERSION = 1;
const DIGEST_BYTES = 16;
const MAGIC = Buffer.from(magicHeader);
// Root arrays split into one segment per element whatever their content.
const SPLIT_ALWAYS = new Set(['characters', 'modules']);
// Any other root array is split when every element is an object and the
// elements are large: a delta then carries the changed element only.
const SPLIT_MIN_TOTAL = 64 * 1024;
const SPLIT_MIN_AVERAGE = 1024;
// Consecutive small segments go out in writes of at least this size.
const WRITE_BYTES = 64 * 1024;
// A stream gives the event loop a turn after this much synchronous work,
// even when the socket keeps accepting writes.
const MAX_SLICE_MS = 20;
// A segment encode this large leaves msgpackr's shared scratch grown (up to
// four times its size); it is handed back after the pass.
const RELEASE_SCRATCH_AFTER = 1024 * 1024;

// POST /api/db/boot, protocol 1.
const BOOT_PROTOCOL = '1';
const BOOT_CONTENT_TYPE = 'application/x-pocketrisu-boot';
const BOOT_MAGIC = Buffer.from('PRB1', 'ascii');
const BOOT_FLAG_KEY = 0x01;
const BOOT_KEY_INFO = 'pocketrisu/boot-cache/v1';
const MAX_HAVE_DIGESTS = 262144;
const MAX_SEGMENTS = 1048576;
const MAX_PREFIX_BYTES = 64;

function bootError(code, message, status) {
    return Object.assign(new Error(message), { code, ...(status ? { status } : {}) });
}

function digestOf(bytes) {
    return nodeCrypto.createHash('sha256').update(bytes).digest().toString('latin1', 0, DIGEST_BYTES);
}

// Kept bytes (a head segment lives as long as its plan) in their own
// ArrayBuffer, not in a slab of the shared Buffer pool.
function ownedConcat(parts) {
    let length = 0;
    for (const part of parts) length += part.length;
    const out = Buffer.allocUnsafeSlow(length);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

function merkleEtag(prefix, segments) {
    const input = Buffer.allocUnsafe(1 + prefix.length + segments.length * (DIGEST_BYTES + 4));
    input[0] = PLAN_VERSION;
    prefix.copy(input, 1);
    let at = 1 + prefix.length;
    for (const segment of segments) {
        input.write(segment.digest, at, DIGEST_BYTES, 'latin1');
        input.writeUInt32BE(segment.len, at + DIGEST_BYTES);
        at += DIGEST_BYTES + 4;
    }
    const hex = nodeCrypto.createHash('sha256').update(input).digest('hex');
    return `m${PLAN_VERSION}-${hex.slice(0, 40)}`;
}

/**
 * @param {object} [options]
 * @param {object} [options.logger]
 * @param {(value: any) => Buffer} [options.encode] - owned msgpack bytes of one value (utils.encodeMsgpackOwned)
 * @param {(root: any) => Buffer} [options.encodeWhole] - the whole payload, for the self-test (utils.encodeRisuSaveLegacyBuffer)
 * @param {(detail: string) => void} [options.onMutation] - a served segment no longer matches its digest
 * @param {() => number} [options.now]
 */
function createBootPayloadPlanner({
    logger = console,
    encode = encodeMsgpackOwned,
    encodeWhole = encodeRisuSaveLegacyBuffer,
    onMutation = null,
    now = () => performance.now(),
} = {}) {
    // element object -> { digest, len } of enc(element)
    let elementMemo = new WeakMap();
    // root value object -> Map(key -> { digest, len } of enc(key) ‖ enc(value))
    let pairMemo = new WeakMap();
    // key -> { value, entry } for a primitive root value (reused when Object.is)
    let primitiveMemo = new Map();
    // root -> plan
    let plans = new WeakMap();
    let disabledReason = null;
    let selfTested = false;
    const counters = {
        plans: 0,
        encodedSegments: 0,
        encodedBytes: 0,
        mutations: 0,
        selfTest: null,
    };
    // The largest segment encoded since the scratch was last handed back.
    let largestEncode = 0;

    const canary = runCanary();
    if (!canary.ok) disable(`msgpack composition canary failed: ${canary.reason}`);

    function disable(reason) {
        if (disabledReason) return;
        disabledReason = reason;
        logger.error(`[Boot] payload planner disabled, database reads encode the whole view: ${reason}`);
    }

    function disabledError() {
        return bootError('BOOT_DISABLED', `boot payload planner is disabled: ${disabledReason}`);
    }

    function encodeCounted(value) {
        const bytes = encode(value);
        counters.encodedSegments++;
        counters.encodedBytes += bytes.length;
        if (bytes.length > largestEncode) largestEncode = bytes.length;
        return bytes;
    }

    function releaseScratchIfGrown() {
        if (largestEncode >= RELEASE_SCRATCH_AFTER) releaseEncodeScratch();
        largestEncode = 0;
    }

    function elementEntry(value) {
        const memoizable = value !== null && typeof value === 'object';
        if (memoizable) {
            const hit = elementMemo.get(value);
            if (hit) return hit;
        }
        const bytes = encodeCounted(value);
        const entry = { digest: digestOf(bytes), len: bytes.length };
        if (memoizable) elementMemo.set(value, entry);
        return entry;
    }

    function pairEntry(key, value, nextPrimitives) {
        const memoizable = value !== null && typeof value === 'object';
        if (memoizable) {
            const hit = pairMemo.get(value)?.get(key);
            if (hit) return hit;
        } else {
            const hit = primitiveMemo.get(key);
            if (hit && Object.is(hit.value, value)) {
                nextPrimitives.set(key, hit);
                return hit.entry;
            }
        }
        const bytes = Buffer.concat([encodeCounted(key), encodeCounted(value)]);
        const entry = { digest: digestOf(bytes), len: bytes.length };
        if (memoizable) {
            let byKey = pairMemo.get(value);
            if (!byKey) {
                byKey = new Map();
                pairMemo.set(value, byKey);
            }
            byKey.set(key, entry);
        } else {
            nextPrimitives.set(key, { value, entry });
        }
        return entry;
    }

    function shouldSplit(key, value) {
        if (!isComposableArray(value)) return false;
        if (SPLIT_ALWAYS.has(key)) return true;
        if (value.length === 0) return false;
        for (let i = 0; i < value.length; i++) {
            const element = value[i];
            if (element === null || typeof element !== 'object') return false;
        }
        let total = 0;
        for (let i = 0; i < value.length; i++) total += elementEntry(value[i]).len;
        return total >= SPLIT_MIN_TOTAL && total >= SPLIT_MIN_AVERAGE * value.length;
    }

    function buildPlan(root) {
        const segments = [];
        let prefix;
        if (isComposableObject(root)) {
            const nextPrimitives = new Map();
            const count = forEachOwnKey(root, (key, value) => {
                if (shouldSplit(key, value)) {
                    const head = ownedConcat([encodeCounted(key), arrayHeader(value.length)]);
                    segments.push({ digest: digestOf(head), len: head.length, kind: 'raw', bytes: head });
                    for (let i = 0; i < value.length; i++) {
                        const element = value[i];
                        const entry = elementEntry(element);
                        segments.push({ digest: entry.digest, len: entry.len, kind: 'value', value: element });
                    }
                } else {
                    const entry = pairEntry(key, value, nextPrimitives);
                    segments.push({ digest: entry.digest, len: entry.len, kind: 'pair', key, value });
                }
            });
            primitiveMemo = nextPrimitives;
            prefix = ownedConcat([MAGIC, mapHeader(count)]);
        } else {
            // msgpackr takes another branch for it: one segment, encoded whole.
            const entry = elementEntry(root);
            segments.push({ digest: entry.digest, len: entry.len, kind: 'value', value: root });
            prefix = ownedConcat([MAGIC]);
        }
        let total = prefix.length;
        let elements = 0;
        for (const segment of segments) {
            total += segment.len;
            if (segment.kind === 'value') elements++;
        }
        counters.plans++;
        return { version: PLAN_VERSION, prefix, segments, total, elements, etag: merkleEtag(prefix, segments) };
    }

    // The plan against a whole encode of the same root: equal length, equal
    // prefix, and every segment's digest equal to the digest of its slice.
    function compareWithWhole(plan, whole) {
        if (whole.length !== plan.total) return `lengths differ (${plan.total} planned, ${whole.length} encoded)`;
        if (!whole.subarray(0, plan.prefix.length).equals(plan.prefix)) return 'the prefix differs';
        let at = plan.prefix.length;
        for (let i = 0; i < plan.segments.length; i++) {
            const segment = plan.segments[i];
            if (digestOf(whole.subarray(at, at + segment.len)) !== segment.digest) {
                return `segment ${i} at offset ${at} differs`;
            }
            at += segment.len;
        }
        return null;
    }

    // Once per process, on the first root whose plan has element segments
    // (smaller roots before it are checked as well, which costs little).
    function selfTest(root, plan) {
        const startedAt = now();
        let mismatch;
        try {
            const whole = encodeWhole(root);
            if (whole.length > largestEncode) largestEncode = whole.length;
            mismatch = compareWithWhole(plan, whole);
        } catch (error) {
            mismatch = `the whole encode threw: ${error?.message ?? error}`;
        }
        const ms = Math.round(now() - startedAt);
        counters.selfTest = { passed: !mismatch, ms, bytes: plan.total, segments: plan.segments.length };
        if (mismatch) {
            disable(`self-test: planned bytes differ from encodeRisuSaveLegacy (${mismatch})`);
            return false;
        }
        if (plan.elements > 0) {
            selfTested = true;
            logger.debug(`[Boot] payload self-test passed: ${(plan.total / 1024 / 1024).toFixed(1)}MB, ${plan.segments.length} segments in ${ms} ms`);
        }
        return true;
    }

    function planFor(root) {
        if (disabledReason) throw disabledError();
        let plan = plans.get(root);
        if (plan) return plan;
        try {
            plan = buildPlan(root);
            if (!selfTested && !selfTest(root, plan)) throw disabledError();
        } finally {
            releaseScratchIfGrown();
        }
        if (root !== null && typeof root === 'object') plans.set(root, plan);
        return plan;
    }

    // planFor, or null once the planner is disabled (the caller then encodes
    // the whole view). A plan that fails for another reason disables it too:
    // that is a planner bug, and the whole encode stays the reference.
    function tryPlan(root) {
        if (disabledReason) return null;
        try {
            return planFor(root);
        } catch (error) {
            if (error?.code !== 'BOOT_DISABLED') disable(`planning failed: ${error?.message ?? error}`);
            return null;
        }
    }

    function etagFor(root) {
        return planFor(root).etag;
    }

    // The bytes of one segment, encoded again and checked against its digest.
    function segmentBytes(segment) {
        if (disabledReason) throw disabledError();
        let bytes;
        if (segment.kind === 'raw') {
            bytes = segment.bytes;
        } else if (segment.kind === 'value') {
            bytes = encode(segment.value);
        } else {
            bytes = Buffer.concat([encode(segment.key), encode(segment.value)]);
        }
        if (bytes.length > largestEncode) largestEncode = bytes.length;
        if (bytes.length !== segment.len || digestOf(bytes) !== segment.digest) {
            counters.mutations++;
            const detail = `a ${segment.kind} segment${segment.kind === 'pair' ? ` of root key ${JSON.stringify(String(segment.key).slice(0, 64))}` : ''}`
                + ` no longer matches its plan (${segment.len} bytes planned, ${bytes.length} encoded)`;
            disable(`BOOT_SEGMENT_MUTATED: ${detail}`);
            if (onMutation) {
                try { onMutation(detail); } catch (error) { logger.error('[Boot] mutation report failed:', error); }
            }
            throw bootError('BOOT_SEGMENT_MUTATED', `boot payload segment changed after planning: ${detail}`);
        }
        return bytes;
    }

    /**
     * Writes `head`, then the bytes of every segment of `plan` whose digest
     * is not in `omit`, in plan order, then ends the response. Small segments
     * are coalesced into writes of at least WRITE_BYTES; a write the socket
     * (or the compression stream) refuses is waited out ('drain'), and the
     * loop stops when the response closes. A segment that fails its digest
     * check throws; the caller destroys the response, or answers some other
     * way if nothing was written yet (res.headersSent).
     * @returns {Promise<{ completed: boolean, bytes: number, segments: number, encodeMs: number }>}
     */
    async function streamSegments(res, plan, { head = null, omit = null } = {}) {
        const result = { completed: false, bytes: 0, segments: 0, encodeMs: 0 };
        let closed = !!(res.destroyed || res.writableEnded);
        let wake = null;
        const resume = () => {
            const resolve = wake;
            wake = null;
            if (resolve) resolve();
        };
        const onClose = () => {
            closed = true;
            resume();
        };
        res.once('close', onClose);
        // One listener for the whole response. The compression middleware
        // moves 'drain' listeners onto its zlib stream, where res.off cannot
        // reach them, so a listener per wait would pile up there.
        res.on('drain', resume);
        const pending = [];
        let pendingBytes = 0;
        let sliceStartedAt = now();
        const write = async (last) => {
            const chunk = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
            pending.length = 0;
            pendingBytes = 0;
            result.bytes += chunk.length;
            const accepted = res.write(chunk);
            if (last || closed) return;
            if (!accepted) {
                await new Promise((resolve) => { wake = resolve; });
            } else if (now() - sliceStartedAt >= MAX_SLICE_MS) {
                await new Promise((resolve) => setImmediate(resolve));
            }
            sliceStartedAt = now();
        };
        try {
            if (head && head.length > 0) {
                pending.push(head);
                pendingBytes += head.length;
            }
            for (const segment of plan.segments) {
                if (closed) break;
                if (omit && omit.has(segment.digest)) continue;
                const startedAt = now();
                const bytes = segmentBytes(segment);
                result.encodeMs += now() - startedAt;
                result.segments++;
                pending.push(bytes);
                pendingBytes += bytes.length;
                if (pendingBytes >= WRITE_BYTES) await write(false);
            }
            if (!closed) {
                if (pendingBytes > 0) await write(true);
                res.end();
                result.completed = true;
            }
        } finally {
            res.removeListener('close', onClose);
            res.removeListener('drain', resume);
            releaseScratchIfGrown();
        }
        result.encodeMs = Math.round(result.encodeMs);
        return result;
    }

    function stats() {
        return {
            disabled: disabledReason,
            selfTested,
            ...counters,
            selfTest: counters.selfTest ? { ...counters.selfTest } : null,
        };
    }

    // Forget every memo keyed on object identity (server.cjs
    // reportCachedRootMutation): the next plan encodes from the content.
    function reset() {
        elementMemo = new WeakMap();
        pairMemo = new WeakMap();
        primitiveMemo = new Map();
        plans = new WeakMap();
    }

    return {
        planFor,
        tryPlan,
        etagFor,
        segmentBytes,
        streamSegments,
        disabled: () => disabledReason,
        disable,
        reset,
        stats,
    };
}

// ── POST /api/db/boot framing (protocol 1) ──────────────────────────────────
// Integers are big-endian.
//   'P' 'R' 'B' '1' | u8 flags (bit 0: key block present)
//   [u8 keyIdLen, keyId (ASCII), u8 32, key[32]]     only when flags bit 0
//   u32 prefixLen (<= 64), prefix
//   u32 segCount (<= 1,048,576)
//   segCount x { digest[16], u32 len, u8 included }
//   the bytes of every included segment, in manifest order
// A segment is included unless `omit` holds its digest (the digests are
// latin1 strings of 16 characters, as parseHaveList returns them).

/**
 * @param {object} plan - a plan from planFor
 * @param {object} [options]
 * @param {Set<string>|null} [options.omit] - digests the client holds
 * @param {{ key: Buffer, keyId: string }|null} [options.key] - the cache key block
 * @returns {{ header: Buffer, includedBytes: number, includedSegments: number }}
 */
function encodeBootHeader(plan, { omit = null, key = null } = {}) {
    if (plan.prefix.length > MAX_PREFIX_BYTES) {
        throw bootError('BOOT_UNFRAMEABLE', `payload prefix of ${plan.prefix.length} bytes does not fit the boot framing`);
    }
    if (plan.segments.length > MAX_SEGMENTS) {
        throw bootError('BOOT_UNFRAMEABLE', `${plan.segments.length} segments do not fit the boot framing`);
    }
    let keyBlock = null;
    if (key) {
        const keyId = Buffer.from(key.keyId, 'ascii');
        if (keyId.length > 255 || key.key.length !== 32) throw bootError('BOOT_UNFRAMEABLE', 'invalid boot cache key');
        keyBlock = Buffer.concat([Buffer.from([keyId.length]), keyId, Buffer.from([32]), key.key]);
    }
    const headerLength = BOOT_MAGIC.length + 1 + (keyBlock ? keyBlock.length : 0)
        + 4 + plan.prefix.length + 4 + plan.segments.length * (DIGEST_BYTES + 5);
    const header = Buffer.allocUnsafeSlow(headerLength);
    let at = BOOT_MAGIC.copy(header, 0);
    header[at++] = keyBlock ? BOOT_FLAG_KEY : 0;
    if (keyBlock) at += keyBlock.copy(header, at);
    header.writeUInt32BE(plan.prefix.length, at);
    at += 4;
    at += plan.prefix.copy(header, at);
    header.writeUInt32BE(plan.segments.length, at);
    at += 4;
    let includedBytes = 0;
    let includedSegments = 0;
    for (const segment of plan.segments) {
        const included = !(omit && omit.has(segment.digest));
        header.write(segment.digest, at, DIGEST_BYTES, 'latin1');
        header.writeUInt32BE(segment.len, at + DIGEST_BYTES);
        header[at + DIGEST_BYTES + 4] = included ? 1 : 0;
        at += DIGEST_BYTES + 5;
        if (included) {
            includedBytes += segment.len;
            includedSegments++;
        }
    }
    return { header, includedBytes, includedSegments };
}

// The have-list body of POST /api/db/boot: concatenated 16-byte digests.
// Returns them as a Set of latin1 strings; a body that is not a Buffer (no
// body, another content type) is an empty list.
function parseHaveList(body) {
    if (!Buffer.isBuffer(body)) return new Set();
    if (body.length % DIGEST_BYTES !== 0) {
        throw bootError('BOOT_HAVE_LIST_INVALID', `have-list length ${body.length} is not a multiple of ${DIGEST_BYTES}`, 400);
    }
    if (body.length / DIGEST_BYTES > MAX_HAVE_DIGESTS) {
        throw bootError('BOOT_HAVE_LIST_TOO_LARGE', `have-list holds more than ${MAX_HAVE_DIGESTS} digests`, 413);
    }
    const have = new Set();
    for (let at = 0; at < body.length; at += DIGEST_BYTES) have.add(body.toString('latin1', at, at + DIGEST_BYTES));
    return have;
}

// The client's cache key: derived from the server's JWT secret (so it
// rotates with it), sent only inside an authenticated boot response body.
function deriveBootCacheKey(secret) {
    const key = nodeCrypto.createHmac('sha256', secret).update(BOOT_KEY_INFO).digest();
    const keyId = nodeCrypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
    return { key, keyId };
}

// If-None-Match lists the etag, raw, quoted or weak (W/"…"). `*` is not
// honoured: a full answer is always correct.
function ifNoneMatchIncludes(header, etag) {
    if (typeof header !== 'string' || !header || !etag) return false;
    for (const part of header.split(',')) {
        let tag = part.trim();
        if (tag.startsWith('W/')) tag = tag.slice(2);
        if (tag.length >= 2 && tag.startsWith('"') && tag.endsWith('"')) tag = tag.slice(1, -1);
        if (tag === etag) return true;
    }
    return false;
}

function isLoopbackAddress(address) {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// A reverse proxy on the same machine (Tailscale Serve, nginx) connects from
// loopback too; these headers, or a Host that is not a loopback name, mark
// a request that came from somewhere else.
const FORWARDING_HEADERS = ['x-forwarded-for', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'via'];
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostName(host) {
    if (typeof host !== 'string') return '';
    const value = host.trim().toLowerCase();
    if (value.startsWith('[')) {
        const end = value.indexOf(']');
        return end === -1 ? value : value.slice(0, end + 1);
    }
    const colon = value.indexOf(':');
    return colon === -1 ? value : value.slice(0, colon);
}

// A browser on this machine talking to the server directly: the only case
// where a database payload is sent without compression.
function isTrueLoopbackRequest(req) {
    if (!isLoopbackAddress(String(req?.socket?.remoteAddress || ''))) return false;
    const headers = req.headers || {};
    for (const name of FORWARDING_HEADERS) {
        if (headers[name] !== undefined) return false;
    }
    return LOOPBACK_HOSTS.has(hostName(headers.host));
}

module.exports = {
    createBootPayloadPlanner,
    encodeBootHeader,
    parseHaveList,
    deriveBootCacheKey,
    ifNoneMatchIncludes,
    isLoopbackAddress,
    isTrueLoopbackRequest,
    PLAN_VERSION,
    DIGEST_BYTES,
    BOOT_PROTOCOL,
    BOOT_CONTENT_TYPE,
    MAX_HAVE_DIGESTS,
    SPLIT_MIN_TOTAL,
    SPLIT_MIN_AVERAGE,
};
