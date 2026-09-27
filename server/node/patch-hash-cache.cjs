'use strict';

// calculateHash's constants (utils.cjs). compose() and valueHash() rebuild
// its object and array branches from cached parts and must stay equal to it.
const PRIME_MULTIPLIER = 31;
const SEED_OBJECT = 17;
const SEED_ARRAY = 19;

function decodePointerSegment(segment) {
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function collectTouchedTopLevelKeys(patch) {
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

function createPatchHashCache(calculateHash) {
    if (typeof calculateHash !== 'function') {
        throw new TypeError('calculateHash must be a function');
    }

    // Per-root state, keyed on the root object.
    let states = new WeakMap();
    // calculateHash of each object that is an element of a root-level array,
    // keyed on the element itself. Installed roots are never changed in
    // place, and /api/patch hands every characters[i] / modules[i] it does
    // not touch to the next root as the same object (patch-selective-
    // clone.cjs), so hashing a new root costs only its new elements.
    let elementHashes = new WeakMap();

    function isObjectRoot(database) {
        return database !== null && typeof database === 'object' && !Array.isArray(database);
    }

    function elementHash(value) {
        if (value === null || typeof value !== 'object') return calculateHash(value);
        let result = elementHashes.get(value);
        if (result === undefined) {
            result = calculateHash(value);
            elementHashes.set(value, result);
        }
        return result;
    }

    // calculateHash(value) for a root-level value. For an array it is the
    // same fold calculateHash's array branch runs, over memoized element
    // hashes, so the result is identical.
    function valueHash(value) {
        if (!Array.isArray(value)) return calculateHash(value);
        let result = SEED_ARRAY;
        for (const item of value) {
            result = (Math.imul(result, PRIME_MULTIPLIER) + elementHash(item)) >>> 0;
        }
        return result;
    }

    function buildState(database) {
        if (!isObjectRoot(database)) {
            return { valueHashes: null, fullHash: calculateHash(database) };
        }

        const valueHashes = new Map();
        for (const key in database) {
            valueHashes.set(key, valueHash(database[key]));
        }
        return { valueHashes, fullHash: null };
    }

    function getState(database) {
        if (!isObjectRoot(database)) return buildState(database);
        let state = states.get(database);
        if (!state) {
            state = buildState(database);
            states.set(database, state);
        }
        return state;
    }

    function compose(database, state) {
        if (!isObjectRoot(database) || state.valueHashes === null) {
            return state.fullHash ?? calculateHash(database);
        }

        let rootHash = SEED_OBJECT;
        for (const key in database) {
            let keyValueHash = state.valueHashes.get(key);
            if (keyValueHash === undefined && !state.valueHashes.has(key)) {
                keyValueHash = valueHash(database[key]);
                state.valueHashes.set(key, keyValueHash);
            }
            rootHash += Math.imul(calculateHash(key), PRIME_MULTIPLIER) + keyValueHash;
        }
        return rootHash >>> 0;
    }

    function hash(database) {
        return compose(database, getState(database));
    }

    // Per-root-key hashes in the same form the client keeps in its
    // hashBlocks, so a 409 can name the keys that diverged instead of only
    // reporting that the whole document did. Fills any missing entries.
    function keyHashes(database) {
        const out = {};
        if (!isObjectRoot(database)) return out;
        const state = getState(database);
        for (const key in database) {
            let keyValueHash = state.valueHashes.get(key);
            if (keyValueHash === undefined && !state.valueHashes.has(key)) {
                keyValueHash = valueHash(database[key]);
                state.valueHashes.set(key, keyValueHash);
            }
            out[key] = keyValueHash;
        }
        return out;
    }

    function update(previousDatabase, nextDatabase, patch) {
        if (!isObjectRoot(nextDatabase)) {
            return calculateHash(nextDatabase);
        }

        const previousState = isObjectRoot(previousDatabase)
            ? getState(previousDatabase)
            : null;
        const { keys, touchesRoot } = collectTouchedTopLevelKeys(patch);

        let nextState;
        if (touchesRoot || !previousState || previousState.valueHashes === null) {
            nextState = buildState(nextDatabase);
        } else {
            const valueHashes = new Map(previousState.valueHashes);
            for (const key of keys) {
                if (Object.prototype.hasOwnProperty.call(nextDatabase, key)) {
                    valueHashes.set(key, valueHash(nextDatabase[key]));
                } else {
                    valueHashes.delete(key);
                }
            }
            nextState = { valueHashes, fullHash: null };
        }

        states.set(nextDatabase, nextState);
        return compose(nextDatabase, nextState);
    }

    // Forget every cached hash. For reportCachedRootMutation in server.cjs:
    // once something changed an installed root in place, no hash keyed on
    // an object's identity can be trusted.
    function reset() {
        states = new WeakMap();
        elementHashes = new WeakMap();
    }

    return { hash, update, keyHashes, elementHash, reset };
}

module.exports = {
    createPatchHashCache,
    collectTouchedTopLevelKeys,
    decodePointerSegment,
};
