'use strict';

const { decodePointerSegment } = require('./patch-hash-cache.cjs');

// Root arrays whose elements a patch can share with the previous root.
// /characters/N/... and /modules/N/... are what a chat turn, a card edit or
// a module edit produces; cloning the whole array for them cost about 0.7s
// per patch on the real database (1,300 characters).
const ELEMENT_SHARED_KEYS = new Set(['characters', 'modules']);
// fast-json-patch turns any run of digits into an array index with ~~index,
// so '01' reaches element 1 and '4294967296' element 0. With validation on it
// refuses add/replace/remove through such a segment (its existence check uses
// the raw key), but that is its behaviour, not a contract: only the canonical
// spelling of an index that exists is trusted to name the element an op
// reaches.
const CANONICAL_INDEX = /^(?:0|[1-9][0-9]*)$/;
// The ops that can be confined to one element (at depth >= 3) or to one slot
// of the array copy (replace and test at depth 2). move, copy and anything
// unknown fall back to the whole branch.
const ELEMENT_OPS = new Set(['add', 'replace', 'remove', 'test']);

function collectPatchTopLevelKeys(patch) {
    const keys = new Set();
    let touchesRoot = false;

    for (const op of Array.isArray(patch) ? patch : []) {
        for (const field of ['path', 'from']) {
            const pointer = op?.[field];
            if (typeof pointer !== 'string') continue;
            if (pointer === '') {
                touchesRoot = true;
                continue;
            }
            if (!pointer.startsWith('/')) {
                touchesRoot = true;
                continue;
            }
            const nextSlash = pointer.indexOf('/', 1);
            const rawSegment = nextSlash === -1
                ? pointer.slice(1)
                : pointer.slice(1, nextSlash);
            keys.add(decodePointerSegment(rawSegment));
        }
    }

    return { keys, touchesRoot };
}

function isPlainPatchRoot(database) {
    return database !== null && typeof database === 'object' && !Array.isArray(database);
}

// The indexes of the elements of root array `key` that the patch can change
// in place, or null when the patch can change the array itself (then the
// whole branch is cloned, as before).
//
// Non-structural means every op naming the array is add/replace/remove/test
// with a canonical index of an existing element and no `from`:
//  - depth >= 3 (/key/N/...): add/replace/remove change element N, which is
//    cloned; test only reads.
//  - depth 2 (/key/N): replace stores the request's value in slot N of the
//    array copy and test only reads, so element N is not changed. add and
//    remove shift the indexes the other ops were checked against: whole
//    branch.
// Ops can then neither reorder nor resize the array, so the index each op
// names at apply time is the one checked here. A depth-2 replace puts a
// request object in the slot; later ops under that index change the request
// object, never a cached one.
function elementIndexesToClone(key, array, patch) {
    const indexes = new Set();
    for (const op of patch) {
        for (const field of ['path', 'from']) {
            const pointer = op?.[field];
            if (typeof pointer !== 'string' || !pointer.startsWith('/')) continue;
            const parts = pointer.split('/');
            if (decodePointerSegment(parts[1]) !== key) continue;
            if (field === 'from') return null;
            if (!ELEMENT_OPS.has(op.op)) return null;
            if (parts.length < 3) return null;
            const segment = parts[2];
            if (!CANONICAL_INDEX.test(segment)) return null;
            const index = Number(segment);
            if (index >= array.length) return null;
            if (parts.length === 3) {
                if (op.op === 'add' || op.op === 'remove') return null;
                continue;
            }
            if (op.op !== 'test') indexes.add(index);
        }
    }
    return indexes;
}

function cloneTouchedBranch(database, key, patch, shareElements) {
    const value = database[key];
    if (shareElements && ELEMENT_SHARED_KEYS.has(key) && Array.isArray(value)) {
        const indexes = elementIndexesToClone(key, value, patch);
        if (indexes) {
            // A new array (a depth-2 replace writes into it) holding the
            // previous root's element objects, except the ones the ops
            // change, which get their own deep copy.
            const copy = value.slice();
            for (const index of indexes) copy[index] = structuredClone(value[index]);
            return copy;
        }
    }
    return structuredClone(value);
}

// A root for applyPatch(snapshot, patch) that shares every branch the patch
// cannot change with `database`, so a failing op leaves `database` untouched
// and a successful one never writes into it. With { shareElements: false }
// every touched top-level branch is cloned whole (the pre-B2 behaviour, kept
// for the test-mode cross-check in server.cjs).
function clonePatchSnapshot(database, patch, { shareElements = true } = {}) {
    if (!isPlainPatchRoot(database)) {
        return structuredClone(database);
    }

    const { keys, touchesRoot } = collectPatchTopLevelKeys(patch);
    if (touchesRoot) {
        return structuredClone(database);
    }

    const ops = Array.isArray(patch) ? patch : [];
    // The root itself must be independent so top-level add/remove/replace ops
    // cannot mutate the live cache. Untouched nested branches stay shared;
    // every top-level branch that a patch can mutate is cloned below, for
    // `characters` and `modules` down to the elements the ops change.
    const snapshot = { ...database };
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(database, key)) {
            Object.defineProperty(snapshot, key, {
                value: cloneTouchedBranch(database, key, ops, shareElements),
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
    }
    return snapshot;
}

module.exports = {
    clonePatchSnapshot,
    collectPatchTopLevelKeys,
    elementIndexesToClone,
    ELEMENT_SHARED_KEYS,
};
