'use strict';

const { applyValidatedOperation, applyValidatedPatch } = require('./patch-validated-apply.cjs');
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
// for the test-mode cross-check in server.cjs). /api/patch itself uses
// applyPatchCopyOnWrite below, which also shares elements across add, remove,
// move and copy at /characters/N.
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
            setOwnValue(snapshot, key, cloneTouchedBranch(database, key, ops, shareElements));
        }
    }
    return snapshot;
}

// An own data property even for a key such as '__proto__', where plain
// assignment would set the prototype instead.
function setOwnValue(target, key, value) {
    Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

// ── copy-on-write apply (/api/patch) ────────────────────────────────────────
// clonePatchSnapshot decides what to clone before any op runs, so an op that
// shifts indexes (add or remove at /characters/N, /characters/-, a move)
// leaves it only the whole branch: a character create or delete copied the
// 227MB array and gave every character a new identity, so the element hash
// memo and the persister's layout missed for all of them. Applying the ops
// one at a time instead lets the array copy be shallow: an element is cloned
// just before an op writes into it, at whatever index the earlier ops of the
// patch have moved it to.

function pointerUnder(pointer, key) {
    if (typeof pointer !== 'string' || !pointer.startsWith('/')) return null;
    const parts = pointer.split('/');
    return decodePointerSegment(parts[1]) === key ? parts : null;
}

// /key/N with a canonical N, or /key/- where an add or a move may name it.
function isSlotPointer(parts, allowEnd) {
    return parts.length === 3 && (CANONICAL_INDEX.test(parts[2]) || (allowEnd && parts[2] === '-'));
}

// Whether every op naming root array `key` can run on a shallow copy of it:
//  - add, replace and remove at /key/N/... (canonical N) write into the
//    element at N when they run, which is cloned first;
//  - add, replace and remove at /key/N, and add at /key/-, write into the
//    array copy only; add and replace put the request's own value there;
//  - move and copy from /key/N to /key/M or /key/- only splice the array
//    copy (fast-json-patch inserts a deep copy of a copied value);
//  - test only reads, wherever it points.
// Anything else naming the key clones the whole branch, as before: the array
// itself, a non-canonical index, a value moved or copied in from another key
// or out to one, move or copy below depth 2 (their inner add runs without
// validation, so '01' or a `from` that prefixes the path would reach an
// element), a `from` on any other op, _get and unknown ops.
function copyOnWriteEligible(key, patch) {
    for (const op of patch) {
        const path = pointerUnder(op?.path, key);
        const from = pointerUnder(op?.from, key);
        if (!path && !from) continue;
        if (op.op === 'move' || op.op === 'copy') {
            if (!path || !from || !isSlotPointer(from, false) || !isSlotPointer(path, true)) return false;
            continue;
        }
        if (from) return false;
        if (op.op === 'test') continue;
        if (op.op !== 'add' && op.op !== 'replace' && op.op !== 'remove') return false;
        if (path.length < 3) return false;
        if (!CANONICAL_INDEX.test(path[2]) && !(op.op === 'add' && isSlotPointer(path, true))) return false;
    }
    return true;
}

// What applyPatch(snapshot, patch, true) returns (the per-op results and
// .newDocument), for a snapshot that shares with `database` every top-level
// branch the patch does not name and, in `characters` and `modules`, every
// element no op writes into (see copyOnWriteEligible; other keys and other
// shapes get clonePatchSnapshot's whole-branch clones). The ops run one by
// one through applyValidatedOperation, which is fast-json-patch's
// applyOperation with the arguments applyPatch passes, so the result and
// which op throws are applyPatch's, and its error has the same name, index
// and operation (built without the document, see patch-validated-apply.cjs);
// replacing an element of the array copy by its clone does not change what
// an op sees. A throw leaves `database` untouched: the ops before it wrote
// only into this call's copies and the request's own values. As with
// applyPatch, op values are linked into the result, so a patch must not
// carry objects reachable from `database`.
function applyPatchCopyOnWrite(database, patch) {
    if (!isPlainPatchRoot(database) || !Array.isArray(patch)) {
        // A whole copy of an odd root; applyPatch refuses a non-array patch.
        return applyValidatedPatch(clonePatchSnapshot(database, patch), patch);
    }
    const { keys, touchesRoot } = collectPatchTopLevelKeys(patch);
    if (touchesRoot) return applyValidatedPatch(structuredClone(database), patch);

    const snapshot = { ...database };
    // key -> the array copy, while elements of `database[key]` may be in it.
    const arrays = new Map();
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(database, key)) continue;
        const value = database[key];
        if (ELEMENT_SHARED_KEYS.has(key) && Array.isArray(value) && copyOnWriteEligible(key, patch)) {
            const copy = value.slice();
            arrays.set(key, copy);
            setOwnValue(snapshot, key, copy);
        } else {
            setOwnValue(snapshot, key, structuredClone(value));
        }
    }
    if (arrays.size === 0) return applyValidatedPatch(snapshot, patch);

    // Elements of an array copy that ops may write into: this call's clones
    // and the values an add or replace put in a slot.
    const owned = new Set();
    const results = new Array(patch.length);
    let document = snapshot;
    for (let i = 0; i < patch.length; i++) {
        const op = patch[i];
        const parts = typeof op?.path === 'string' && op.path.startsWith('/') ? op.path.split('/') : null;
        const key = parts ? decodePointerSegment(parts[1]) : null;
        const array = parts ? arrays.get(key) : undefined;
        if (array && parts.length > 3 && op.op !== 'test') {
            // add, replace or remove below /key/N (N canonical, checked above).
            const index = Number(parts[2]);
            if (index < array.length) {
                const element = array[index];
                if (element !== null && typeof element === 'object' && !owned.has(element)) {
                    const copy = structuredClone(element);
                    array[index] = copy;
                    owned.add(copy);
                }
            } else {
                // No element there: with validation on, fast-json-patch
                // refuses the op before it writes anything. Should it not,
                // it writes into a whole-branch copy.
                setOwnValue(document, key, structuredClone(array));
                arrays.delete(key);
            }
        }
        results[i] = applyValidatedOperation(document, op, i);
        document = results[i].newDocument;
        if (array && parts.length === 3 && (op.op === 'add' || op.op === 'replace')
            && op.value !== null && typeof op.value === 'object') {
            owned.add(op.value);
        }
    }
    results.newDocument = document;
    return results;
}

module.exports = {
    applyPatchCopyOnWrite,
    clonePatchSnapshot,
    collectPatchTopLevelKeys,
    copyOnWriteEligible,
    elementIndexesToClone,
    ELEMENT_SHARED_KEYS,
};
