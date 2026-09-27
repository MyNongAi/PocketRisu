'use strict';

// Structural msgpack helpers: what is needed to assemble the exact bytes
// packr.encode(value) writes from separately encoded parts. The boot planner
// (per-segment payload) and the incremental persister (per-owner spans) both
// build on this, so the rules live in one place and are tested once.
//
// Scope: msgpackr pinned at 1.11.9 (package.json) with { useRecords: false },
// the options of utils.cjs. With those options no encoding depends on what
// was written before it (no records, shared structures, bundled strings or
// reference map), so for the two containers below
//     encode(container) = header ‖ encode(child) ‖ encode(child) …
// and each child's bytes may come from anywhere, provided they are exactly
// encode(child). What msgpackr does (pack.js, `pack`, 'object' branch):
//  - value.constructor === Object: writePlainObject. Always 0xde and a u16
//    count (map16, even for fewer than 16 keys), then pack(key) ‖ pack(value)
//    for every key `for…in` yields where
//    `typeof obj.hasOwnProperty !== 'function' || obj.hasOwnProperty(key)`.
//    More than 0xffff such keys throws.
//  - value.constructor === Array: packArray. fixarray, 0xdc u16 or 0xdd u32,
//    then value[0] … value[length - 1].
//  - anything else takes another branch: a null-prototype object, a class
//    instance, an object with its own `constructor` key, Map, Date, typed
//    arrays and Buffers, msgpackr extensions such as StoredChatBytes. The
//    predicates below are false for all of them, and a composer encodes such
//    a value whole with packr.
// runCanary checks these rules against the msgpackr that is installed.

const { encodeMsgpackOwned } = require('./utils.cjs');

const MAP16 = 0xde;
const ARRAY16 = 0xdc;
const ARRAY32 = 0xdd;
const FIXARRAY = 0x90;
const MAX_MAP16_KEYS = 0xffff;

// msgpackr writes this value with writePlainObject.
function isComposableObject(value) {
    return value !== null && typeof value === 'object' && value.constructor === Object;
}

// msgpackr writes this value with packArray.
function isComposableArray(value) {
    return Array.isArray(value) && value.constructor === Array;
}

// Calls fn(key, value) for each key msgpackr writes for a composable object,
// in the order it writes them. Returns the count, which mapHeader needs.
function forEachOwnKey(object, fn) {
    let count = 0;
    for (const key in object) {
        // The same test, evaluated the same way (per key), as writePlainObject.
        if (typeof object.hasOwnProperty !== 'function' || object.hasOwnProperty(key)) {
            fn(key, object[key]);
            count++;
        }
    }
    return count;
}

// The header writePlainObject writes for `count` keys.
function mapHeader(count) {
    if (!Number.isInteger(count) || count < 0) throw new RangeError(`invalid map size ${count}`);
    if (count > MAX_MAP16_KEYS) {
        // msgpackr throws here too; it has no map32 path for plain objects.
        throw new RangeError(`an object with ${count} keys does not fit msgpackr's 16-bit map size`);
    }
    return Buffer.from([MAP16, count >> 8, count & 0xff]);
}

// The header packArray writes for an array of `length` elements.
function arrayHeader(length) {
    if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) {
        throw new RangeError(`invalid array length ${length}`);
    }
    if (length < 0x10) return Buffer.from([FIXARRAY | length]);
    if (length < 0x10000) return Buffer.from([ARRAY16, length >> 8, length & 0xff]);
    const header = Buffer.allocUnsafe(5);
    header[0] = ARRAY32;
    header.writeUInt32BE(length, 1);
    return header;
}

// encode(value), assembled from headers and encode() of keys and leaves.
// Composable containers are expanded down to `maxDepth` levels (the root is
// level 0); deeper ones, and every other value, are encoded whole.
function composeEncode(value, { encode = encodeMsgpackOwned, maxDepth = Infinity } = {}) {
    const parts = [];
    const push = (bytes) => parts.push(bytes);
    (function walk(node, depth) {
        if (depth <= maxDepth && isComposableObject(node)) {
            const at = parts.length;
            parts.push(null);
            const count = forEachOwnKey(node, (key, child) => {
                push(encode(key));
                walk(child, depth + 1);
            });
            parts[at] = mapHeader(count);
        } else if (depth <= maxDepth && isComposableArray(node)) {
            push(arrayHeader(node.length));
            for (let i = 0; i < node.length; i++) walk(node[i], depth + 1);
        } else {
            push(encode(node));
        }
    })(value, 0);
    return Buffer.concat(parts);
}

// A small probe that touches every rule above: map16 for 0 and more than 15
// keys, integer-like keys (for…in puts them first), an own `__proto__` key,
// a `hasOwnProperty` key holding a string, an own `constructor` key and a
// null-prototype object (both encoded whole), fixarray/array16, UTF-8 at the
// fixstr/str8 boundary, a float, -0, a large integer, null and undefined.
function buildCanarySample() {
    const wide = {};
    for (let i = 0; i < 17; i++) wide[`k${i}`] = i;
    const nullProto = Object.create(null);
    nullProto.b = 1;
    nullProto.a = [2];
    return {
        10: 'ten',
        2: 'two',
        name: '가나다라마바사아자차카타파하',
        utf8At32: 'x'.repeat(29) + '가',
        wide,
        empty: {},
        emptyList: [],
        list16: Array.from({ length: 16 }, (_, i) => ({ i, t: i % 2 === 0 ? 'even' : null })),
        numbers: [0, 127, 128, -1, -33, 65535, 2 ** 40, -(2 ** 40), 0.5, -0, 1e300],
        flags: [true, false, null, undefined],
        protoKey: JSON.parse('{"__proto__":{"x":1},"after":2}'),
        ownCheck: { hasOwnProperty: 'not a function', v: 1 },
        ctorKey: { constructor: 'plain data', v: 2 },
        nullProto,
        nested: { chats: [{ id: 'c', name: '', _stub: true, lastDate: 1727400000000 }] },
    };
}

// Proves, for `sample`, that composeEncode reproduces encode(sample) byte for
// byte. Returns { ok: true, bytes } or { ok: false, reason }; never throws.
// A caller that composes bytes (the persister, the boot planner) runs this
// once and falls back to whole encodes when it fails, e.g. after a msgpackr
// upgrade that changes how objects are written.
function runCanary(sample = buildCanarySample(), { encode = encodeMsgpackOwned, maxDepth = Infinity } = {}) {
    try {
        const expected = toBuffer(encode(sample));
        const composed = composeEncode(sample, { encode, maxDepth });
        if (expected.equals(composed)) return { ok: true, bytes: composed.length };
        let at = 0;
        const limit = Math.min(expected.length, composed.length);
        while (at < limit && expected[at] === composed[at]) at++;
        return {
            ok: false,
            reason: `composed bytes differ from encode() at offset ${at} (lengths ${composed.length} / ${expected.length})`,
        };
    } catch (error) {
        return { ok: false, reason: `canary threw: ${error?.message ?? error}` };
    }
}

function toBuffer(bytes) {
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

module.exports = {
    isComposableObject,
    isComposableArray,
    forEachOwnKey,
    mapHeader,
    arrayHeader,
    composeEncode,
    buildCanarySample,
    runCanary,
};
