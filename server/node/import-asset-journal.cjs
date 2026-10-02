'use strict';

// Rollback bookkeeping for cancellable client imports (large CHARX files, see
// src/ts/importTransaction.ts).
//
// Assets are content-addressed and shared: two cards carrying the same image
// store one object, and an import writing an image another bot already uses
// just gets that object back. So a cancelled import may only delete an object
// it can prove is its own. An object is a rollback candidate when
//   1. a write tagged with this import created it (it did not exist before),
//   2. no other write (untagged, or another import's) touched it afterwards,
//      since that writer may now rely on it, and
//   3. no storage-wide operation (backup import, external migration, provider
//      change) ran while the journal was open,
// and the rollback still asks the caller whether the persisted database
// references it before deleting anything.
//
// Writes of one external object are serialized through withKeyLock, so "did
// it exist before?" and "did someone else write it since?" have one order,
// and the rollback deletes under the same lock after a last ownership check.
// Internal (`assets/*` KV) writes and the rollback both run in the server's
// storage queue, which serializes them already.
//
// Journals live in memory. A restart forgets them, and a forgotten journal
// deletes nothing: the cancelled import's objects then stay, as unreferenced
// leftovers, which is the same as before this journal existed.

const IMPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CLOSED_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_JOURNALS = 64;
const DEFAULT_MAX_KEYS = 200000;

function isImportId(value) {
    return typeof value === 'string' && IMPORT_ID_RE.test(value);
}

function isInternalAssetKey(key) {
    return typeof key === 'string' && key.startsWith('assets/');
}

function createImportAssetJournal(options = {}) {
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const closedTtlMs = options.closedTtlMs ?? DEFAULT_CLOSED_TTL_MS;
    const maxJournals = options.maxJournals ?? DEFAULT_MAX_JOURNALS;
    const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;

    const journals = new Map(); // id -> journal
    const creators = new Map(); // key -> id of the open journal that created it
    const closed = new Map(); // id -> closedAt; late writes of a finished import are refused
    const locks = new Map(); // key -> tail of the lock chain

    function dropJournal(id) {
        const journal = journals.get(id);
        if (journal) {
            for (const key of journal.created) {
                if (creators.get(key) === id) creators.delete(key);
            }
            journals.delete(id);
        }
        closed.set(id, now());
    }

    function expire() {
        const time = now();
        for (const [id, journal] of journals) {
            if (time - journal.touchedAt > ttlMs) dropJournal(id);
        }
        for (const [id, closedAt] of closed) {
            if (time - closedAt > closedTtlMs) closed.delete(id);
        }
    }

    function begin(id) {
        if (!isImportId(id)) throw Object.assign(new Error('Invalid import id'), { statusCode: 400 });
        expire();
        if (closed.has(id)) throw Object.assign(new Error('This import already finished'), { statusCode: 409 });
        let journal = journals.get(id);
        if (!journal) {
            if (journals.size >= maxJournals) {
                throw Object.assign(new Error('Too many imports are open'), { statusCode: 429 });
            }
            journal = {
                id,
                touchedAt: now(),
                created: new Set(),
                reused: new Set(),
                shared: new Set(),
                unsafe: null,
                closing: false,
            };
            journals.set(id, journal);
        }
        journal.touchedAt = now();
        return journal;
    }

    /** True when writes tagged with this id must be refused (finished or rolling back). */
    function isClosed(id) {
        return closed.has(id) || journals.get(id)?.closing === true;
    }

    /**
     * Every asset write reports here once it stored the object: inside
     * withKeyLock for external objects, inside the storage queue for internal
     * ones. `created` is true only when the object did not exist before.
     */
    function recordWrite(key, importId, created) {
        const creator = creators.get(key);
        if (creator !== undefined && creator !== importId) {
            // Someone else wrote the same object: it is no longer only ours.
            journals.get(creator)?.shared.add(key);
        }
        const journal = isImportId(importId) ? journals.get(importId) : undefined;
        if (!journal || journal.closing) return;
        journal.touchedAt = now();
        if (journal.created.has(key)) return;
        if (created && creator === undefined) {
            if (journal.created.size >= maxKeys) {
                journal.unsafe ??= 'too-many-assets';
                return;
            }
            journal.created.add(key);
            creators.set(key, journal.id);
        } else {
            journal.reused.add(key);
        }
    }

    /** A storage-wide operation started: open journals delete nothing any more. */
    function markUnsafe(reason) {
        for (const journal of journals.values()) journal.unsafe ??= String(reason || 'storage operation');
    }

    function owns(id, key) {
        const journal = journals.get(id);
        return !!journal
            && !journal.unsafe
            && journal.created.has(key)
            && !journal.shared.has(key)
            && creators.get(key) === id;
    }

    async function withKeyLock(key, operation) {
        const previous = locks.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        const tail = previous.then(() => current);
        locks.set(key, tail);
        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (locks.get(key) === tail) locks.delete(key);
        }
    }

    /**
     * Rolls one import back. The persisted-database check is either
     * `isReferenced(key)` or `referenceCheck()`, which resolves to such a
     * function; null means the scan failed and nothing is deleted.
     * `removeInternal(keys)` deletes internal keys synchronously;
     * `removeExternal(key)` deletes one external object and resolves true when
     * it is gone. The scan and the internal deletes run inside `storageQueue`
     * (the server's storage queue, which internal writes share); external
     * objects are deleted after it, each under its key lock, so a long cleanup
     * does not hold up database saves. Closes the journal whatever happens.
     */
    async function rollback(id, {
        isReferenced,
        referenceCheck,
        removeInternal,
        removeExternal,
        storageQueue = (operation) => operation(),
    }) {
        const journal = journals.get(id);
        const result = { removed: 0, kept: 0, reused: 0, reasons: {} };
        const keep = (reason) => {
            result.kept++;
            result.reasons[reason] = (result.reasons[reason] || 0) + 1;
        };
        if (!journal) {
            closed.set(id, now());
            return { ...result, unknown: true };
        }
        journal.closing = true;
        result.reused = journal.reused.size;
        try {
            const external = await storageQueue(async () => {
                const check = referenceCheck ? await referenceCheck() : isReferenced;
                const internal = [];
                const externalKeys = [];
                for (const key of journal.created) {
                    if (journal.unsafe) keep('unsafe');
                    else if (journal.shared.has(key)) keep('shared');
                    else if (typeof check !== 'function') keep('reference-scan-failed');
                    else if (check(key)) keep('referenced');
                    else (isInternalAssetKey(key) ? internal : externalKeys).push(key);
                }

                // Synchronous: no write can land between this check and the delete.
                const ownedInternal = internal.filter((key) => owns(id, key));
                for (let i = ownedInternal.length; i < internal.length; i++) keep('shared');
                if (ownedInternal.length > 0) {
                    removeInternal(ownedInternal);
                    result.removed += ownedInternal.length;
                }
                return externalKeys;
            });

            for (const key of external) {
                const outcome = await withKeyLock(key, async () => {
                    // A storage-wide operation may have started since the scan.
                    if (journal.unsafe) return 'unsafe';
                    if (!owns(id, key)) return 'shared';
                    return (await removeExternal(key)) ? 'removed' : 'not-removable';
                }).catch(() => 'remove-failed');
                if (outcome === 'removed') result.removed++;
                else keep(outcome);
            }
        } finally {
            dropJournal(id);
        }
        result.kept += result.reused;
        return result;
    }

    /** The import finished: forget it without deleting anything. */
    function commit(id) {
        if (!isImportId(id)) throw Object.assign(new Error('Invalid import id'), { statusCode: 400 });
        dropJournal(id);
    }

    function stats() {
        return { open: journals.size, tracked: creators.size, closed: closed.size, locks: locks.size };
    }

    return {
        begin,
        commit,
        isClosed,
        recordWrite,
        markUnsafe,
        withKeyLock,
        rollback,
        stats,
    };
}

module.exports = {
    createImportAssetJournal,
    isImportId,
};
