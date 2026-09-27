'use strict';

// ChatBodyStore: the chat bodies the server holds, kept as msgpack bytes.
//
// The client view (dbCache) carries chats as stubs; the bodies live here.
// They used to be JS objects in a Map (fullChatStore). They are now the
// exact bytes msgpackr writes for the body, in Buffers that own their memory:
// off the V8 heap, never walked by the GC, and already in the form every hot
// path needs (GET /api/chat-content sends them as they are, a persist can
// splice them into database.bin, ETags are cached per body).
//
// What is stored is packr.encode(body) of exactly the object the old Map held
// (no normalization), so every byte the server sends or writes is the same
// as before. Nothing outside this module can reach a stored object:
//  - getChat() decodes a fresh private copy per call; the caller may mutate
//    it, and only commit()/setChat() change the store;
//  - getEncoded() returns the stored Buffer itself. It is READ-ONLY: never
//    write into it, transfer it or detach it (a detached buffer is caught
//    before it can be persisted, CHAT_STORE_CORRUPT).
//
// getEncoded identity contract (the incremental persister keys on it):
//  - the Buffer is the same object for as long as the body's bytes do not
//    change: across onDisk marking, no-op persists, a commit or reload that
//    brings identical bytes, and a reload that keeps an unwritten body;
//  - any change of the bytes installs a new Buffer. A new Buffer may also
//    come with identical bytes (after reset(), or a body re-read from disk
//    that the store did not hold before), which only costs a cache miss;
//  - bodyVersion(chaId, chatId) is an integer alias of that identity.
//
// Tokens. snapshotToken() = { storeId, wseq }:
//  - storeId changes only on reset() (the store was dropped: import,
//    snapshot restore, migration, a failed post-write update);
//  - wseq counts client-originated body changes (commit/setChat/
//    replaceCharacter) and nothing else.
// Every entry carries the wseq of the commit that installed it (0 for bodies
// read from disk) and an onDisk flag. onDisk === false means a reload from
// database.bin would not bring this body back (acknowledged but unpersisted,
// journaled, activated from an archive row, cold-restored). A reload keeps
// every such entry as it is, wseq included, so a token taken before a reload
// stays valid and an acknowledged body can never be replaced by the older
// disk copy. A persist marks what it wrote onDisk; see acceptPersisted.
//
// All methods are synchronous, so each is atomic with respect to the event
// loop. The server calls them inside its storage queue.

const nodeCrypto = require('crypto');
const { Packr, Unpackr, addExtension } = require('msgpackr');
const { encodeMsgpackOwned, magicHeader } = require('./utils.cjs');
const { computeChatEtag } = require('./chat-content-etag.cjs');

// Same options as utils.cjs: the bytes are what encodeRisuSaveLegacy writes
// for the same value after its 11-byte header, and what it decodes back to.
const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false, int64AsType: 'number' });
const LEGACY_MAGIC = Buffer.from(magicHeader);
// Every INLAY_REF_RE alternative ({{inlay::, {{inlayed::, {{inlayeddata::)
// starts with this, and msgpack stores strings as raw UTF-8.
const INLAY_MARKER = Buffer.from('{{inlay', 'utf8');
// msgpack fixstr "__proto__". msgpackr renames that key to "__proto_" when
// decoding, so a body carrying it would not decode back to its own bytes.
const PROTO_KEY_BYTES = Buffer.concat([Buffer.from([0xa0 | 9]), Buffer.from('__proto__', 'utf8')]);
const META_FIELDS = ['id', 'name', 'lastDate', 'folderId', 'modules'];

function storeError(code, message) {
    return Object.assign(new Error(message), { code });
}

// A chat whose merge with its catalog stub changes nothing, as it stands in
// the database object a persist encodes (getMergedChatForDisk): msgpackr
// writes the stored bytes where the merged chat's encoding would go. Those
// are the same bytes (mergeIsNoop), so the persist neither decodes the body
// nor encodes it again. Code that walks such a database sees no `_stub` and
// no `message`, so a guard that does not know this class treats the chat as
// bodiless and refuses the persist (the safe direction); the persist path's
// own guards ask `hasMessageArray`.
class StoredChatBytes {
    constructor(body, id) {
        this.body = body;
        this.id = id;
        Object.freeze(this);
    }
    get hasMessageArray() {
        return this.body.hasMessageArray;
    }
}

// msgpackr hands an extension's pack() a writer for raw bytes at the current
// position (the same path it uses for Buffers); returning nothing writes no
// extension header, so the stored bytes land verbatim. The type code is
// required by addExtension and only reserves the decoder slot: data carrying
// it is refused exactly like any unknown extension type before.
const STORED_CHAT_EXT_TYPE = 99;
addExtension({
    Class: StoredChatBytes,
    type: STORED_CHAT_EXT_TYPE,
    pack(value, allocateForWrite) {
        const { bytes, byteLength } = value.body;
        if (bytes.length !== byteLength) throw storeError('CHAT_STORE_CORRUPT', 'chat body buffer was detached');
        const { target, position } = allocateForWrite(byteLength);
        target.set(bytes, position);
    },
    unpack() {
        throw new Error(`Unknown extension type ${STORED_CHAT_EXT_TYPE}`);
    },
});

/**
 * Convert a full chat to a stub (metadata only).
 *
 * Hybrid corruption guard: a chat carrying `_stub: true` AND a real `message`
 * array is the v1.4.x legacy hybrid pattern. The fast-path "if _stub return"
 * would propagate the corruption (server reassemble skips merge for _stub
 * chats with no fullChat lookup match). Treat hybrids as real chats and
 * collapse them to a real stub here.
 */
function chatToStub(chat) {
    if (!chat) return chat;
    if (chat._stub && !Array.isArray(chat.message)) return chat;
    const stub = {
        id: chat.id || '',
        name: chat.name ?? '',
        _stub: true,
    };
    // Preserve key presence even when the value is null/undefined so the
    // round-trip distinguishes "user cleared" from "field absent". See
    // mergeChatStubWithFullChat — it relies on `in` semantics.
    if ('lastDate' in chat) stub.lastDate = chat.lastDate;
    if ('folderId' in chat) stub.folderId = chat.folderId;
    if ('modules' in chat) stub.modules = chat.modules;
    return stub;
}

/**
 * The full chat a catalog stub stands for: the stored body with the stub's
 * metadata. Returns a new object when it merges.
 */
function mergeChatStubWithFullChat(stub, fullChat) {
    if (!fullChat) {
        return stub;
    }
    if (!stub || !stub._stub) {
        return fullChat;
    }
    const merged = {
        ...fullChat,
        id: stub.id || fullChat.id || '',
        name: stub.name,
    };
    // Defensive: never let `_stub: true` ride along on a merged chat. If
    // fullChat carries a stale flag (legacy disk corruption), the spread
    // would propagate the hybrid pattern back to disk and re-trigger the
    // chat-data loss path on next round-trip.
    if ('_stub' in merged) delete merged._stub;
    // Use key presence (`in`) so an explicit null/undefined from the client —
    // meaning "user cleared this field" — overwrites fullChat. The previous
    // `!= null` check conflated "cleared" with "absent" and silently kept
    // stale folderId / modules on disk, producing orphan-folder chats.
    if ('lastDate' in stub) merged.lastDate = stub.lastDate;
    if ('folderId' in stub) merged.folderId = stub.folderId;
    if ('modules' in stub) merged.modules = stub.modules;
    return merged;
}

// msgpack bytes of a single value as a latin1 string: a private copy (the
// view packr.encode returns is msgpackr's shared scratch) that compares with
// ===. Values are context-free in msgpack with useRecords: false, so this is
// exactly how the value is written inside any object.
function encodedKey(value) {
    return packr.encode(value).toString('latin1');
}

// Only own enumerable keys survive an encode/decode, and the merge spreads
// exactly those.
function hasField(obj, key) {
    return Object.prototype.propertyIsEnumerable.call(obj, key);
}

// What mergeIsNoop needs to know about a body, captured as encoded bytes (a
// stub that shared an array with the body and was edited in place must not
// make the stale body look current).
function captureMeta(obj) {
    const meta = { hasStubKey: hasField(obj, '_stub') };
    for (const key of META_FIELDS) {
        meta[key] = hasField(obj, key) ? { enc: encodedKey(obj[key]), truthy: !!obj[key] } : null;
    }
    return meta;
}

// True iff encode(mergeChatStubWithFullChat(stub, body)) is byte-identical
// to encode(body). The merge spreads the body (same keys, same order) and
// then overwrites id and name, and lastDate/folderId/modules when the stub
// has them, and drops _stub. Overwriting a key that exists keeps its
// position, so the bytes are unchanged iff the body has no _stub key, has
// every key the merge writes, and each written value encodes like the one
// it replaces. Anything else is left to the slow path (always correct).
function mergeIsNoop(meta, stub) {
    if (!stub || !stub._stub) return true; // the merge returns the body itself
    if (meta.hasStubKey) return false;
    if (!meta.id) return false;
    const mergedId = stub.id ? encodedKey(stub.id) : (meta.id.truthy ? meta.id.enc : encodedKey(''));
    if (mergedId !== meta.id.enc) return false;
    if (!meta.name || encodedKey(stub.name) !== meta.name.enc) return false;
    for (const key of ['lastDate', 'folderId', 'modules']) {
        if (!(key in stub)) continue;
        if (!meta[key] || encodedKey(stub[key]) !== meta[key].enc) return false;
    }
    return true;
}

function countStringMessages(obj) {
    if (!Array.isArray(obj.message)) return 0;
    let count = 0;
    for (const msg of obj.message) if (typeof msg?.data === 'string') count++;
    return count;
}

// Owned exact-size copy unless the Buffer already owns exactly its memory.
function ownedBytes(buf) {
    if (Buffer.isBuffer(buf) && buf.byteOffset === 0 && buf.buffer.byteLength === buf.length) return buf;
    const out = Buffer.allocUnsafeSlow(buf.length);
    out.set(buf);
    return out;
}

function md5Hex(...parts) {
    const hash = nodeCrypto.createHash('md5');
    for (const part of parts) hash.update(part);
    return hash.digest('hex');
}

// Test hardening (POCKETRISU_TEST_FREEZE_CACHE): freeze a value and
// everything reachable from it. Typed arrays cannot be frozen and are left.
function deepFreeze(value, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    if (ArrayBuffer.isView(value)) return value;
    for (const key of Object.keys(value)) deepFreeze(value[key], seen);
    Object.freeze(value);
    return value;
}

function mapFor(map, key) {
    let inner = map.get(key);
    if (!inner) {
        inner = new Map();
        map.set(key, inner);
    }
    return inner;
}

function pairKey(chaId, chatId) {
    return JSON.stringify([chaId, chatId]);
}

/**
 * @param {object} options
 * @param {object} options.pendingChatPayloads - pending-chat-payloads.cjs instance
 * @param {object} [options.logger]
 * @param {(chat: object) => boolean} [options.isColdStorageChat] - server's cold-storage marker test
 * @param {boolean} [options.testHardening] - freeze handed-out merged chats and
 *   verify stored bytes on every read (tests only)
 */
function createChatBodyStore({ pendingChatPayloads, logger = console, isColdStorageChat = () => false, testHardening = false } = {}) {
    let chars = new Map();          // chaId -> Map<chatId, Entry>; a map may be empty (registered by /activate)
    let registeredAt = new Map();   // chaId -> wseq of the replaceCharacter that registered it
    let charRev = new Map();        // chaId -> revision
    let loaded = false;
    let storeId = 1;
    let wseq = 0;
    let rev = 0;
    let loadRev = ++rev;
    let bodyVer = 0;
    // getMergedChat results whose merge was a no-op -> the body they came
    // from, so acceptPersistedDatabase can keep that body without encoding.
    let noopMerged = new WeakMap();

    // The server's test calls data.startsWith(), which throws a TypeError for
    // a message whose data is not a string: such a chat is not cold.
    function isCold(obj) {
        try {
            return !!isColdStorageChat(obj);
        } catch (error) {
            if (error instanceof TypeError) return false;
            throw error;
        }
    }

    // Body = one Buffer and what is derived from it. Shared by every entry
    // that holds those bytes; only the lazy caches are ever written.
    function makeBody(obj, bytes) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            throw new TypeError('A chat body must be an object');
        }
        let owned = bytes ? ownedBytes(bytes) : encodeMsgpackOwned(obj);
        if (owned.indexOf(PROTO_KEY_BYTES) !== -1) {
            // Store what a decode gives back, so bytes and getChat() agree.
            obj = unpackr.decode(owned);
            owned = encodeMsgpackOwned(obj);
        }
        return {
            bytes: owned,
            byteLength: owned.length,
            ver: ++bodyVer,
            meta: captureMeta(obj),
            hasMessageArray: Array.isArray(obj.message),
            cold: isCold(obj),
            stringMessages: countStringMessages(obj),
            digest: testHardening ? md5Hex(owned) : null,
            etag: null,
            md5: null,
            jsonLength: null,
        };
    }

    function intact(body) {
        if (body.bytes.length !== body.byteLength) {
            throw storeError('CHAT_STORE_CORRUPT', 'chat body buffer was detached');
        }
        if (body.digest !== null && md5Hex(body.bytes) !== body.digest) {
            throw storeError('CHAT_STORE_CORRUPT', 'chat body buffer was written to');
        }
        return body;
    }

    function assertLoaded() {
        if (!loaded) throw storeError('CHAT_STORE_NOT_LOADED', 'chat body store is not loaded');
    }

    function entryOf(chaId, chatId) {
        assertLoaded();
        return chars.get(chaId)?.get(chatId);
    }

    function bodyOf(chaId, chatId) {
        const entry = entryOf(chaId, chatId);
        return entry ? intact(entry.body) : undefined;
    }

    function bumpRev(chaId) {
        charRev.set(chaId, ++rev);
    }

    function pendingPairs() {
        const set = new Set();
        for (const [chaId, chatId] of pendingChatPayloads.pairs()) set.add(pairKey(chaId, chatId));
        return set;
    }

    // A private copy of a catalog chat with the fixes the old initChatStore
    // made in place: a hybrid (_stub: true with a message array) loses the
    // flag, a chat without an id gets one. Returns the chat itself when
    // nothing needs fixing.
    function planFix(chat) {
        const hybrid = chat._stub === true;
        const newId = chat.id ? null : nodeCrypto.randomUUID();
        if (!hybrid && !newId) return { obj: chat, hybrid, newId };
        const obj = { ...chat };
        if (hybrid) delete obj._stub;
        if (newId) obj.id = newId;
        return { obj, hybrid, newId };
    }

    function applyFixInPlace(chat, plan) {
        if (plan.hybrid) delete chat._stub;
        if (plan.newId) chat.id = plan.newId;
    }

    // Journaled bodies (pendingChatPayloads) the next state lacks. Throws on
    // an invalid record, before anything changed.
    function restorePendingInto(next, onlyMissing) {
        const pending = onlyMissing ? pendingPairs() : null;
        if (pending) {
            let missing = false;
            for (const key of pending) {
                const [chaId, chatId] = JSON.parse(key);
                if (!next.get(chaId)?.has(chatId)) { missing = true; break; }
            }
            if (!missing) return [];
        }
        const installed = [];
        for (const { chaId, chatId, chat } of pendingChatPayloads.entries()) {
            if (next.get(chaId)?.has(chatId)) continue;
            mapFor(next, chaId).set(chatId, { body: makeBody(chat), wseq: 0, onDisk: false });
            installed.push(chaId);
        }
        return installed;
    }

    // retireCommitted reads `message` and `_stub` of the chats it looks up:
    // a StoredChatBytes stands for a chat without `_stub` whose body has a
    // message array iff hasMessageArray.
    function retireView(fullDb) {
        return {
            characters: fullDb.characters.map((char) => (!Array.isArray(char?.chats) ? char : {
                chaId: char.chaId,
                chats: char.chats.map((chat) => (chat instanceof StoredChatBytes
                    ? { id: chat.id, ...(chat.hasMessageArray ? { message: [] } : {}) }
                    : chat)),
            })),
        };
    }

    // Copy-on-write view of `chars` for building a next state.
    function cloneChars() {
        const next = new Map();
        for (const [chaId, m] of chars) next.set(chaId, new Map(m));
        return next;
    }

    const store = {
        get loaded() { return loaded; },
        get storeId() { return storeId; },
        get characterCount() { return loaded ? chars.size : 0; },

        snapshotToken() {
            return { storeId, wseq };
        },

        // ── lifecycle ──────────────────────────────────────────────────────

        /**
         * (Re)load from a database decoded from disk. Mirrors the old
         * initChatStore: bodiless stubs are skipped, hybrids lose their
         * `_stub` flag, chats without an id get one, and journaled bodies
         * fill what the database lacks. `fixInPlace` applies those two fixes
         * to `dbObj` itself (it is a fresh decode the caller strips next);
         * otherwise only the store's copy is fixed.
         * `pendingOverridesBodilessStubsOf`: the database as read from disk
         * when `dbObj` had chats filled from archive rows; a journaled body
         * then replaces a row body for a chat that is a bodiless stub there
         * (a journaled body is newer than any row).
         * A reload of a loaded store keeps every entry that is not on disk
         * (acknowledged, journaled, activated, cold-restored), unchanged.
         * Everything is built aside and swapped at the end: a throw (an
         * invalid journal record) leaves the previous store in place.
         */
        loadFromDatabase(dbObj, { fixInPlace = true, pendingOverridesBodilessStubsOf = null } = {}) {
            const next = new Map();
            const fixes = [];
            for (const char of dbObj?.characters ?? []) {
                if (!char?.chaId || !char.chats) continue;
                for (const chat of char.chats) {
                    if (!chat || typeof chat !== 'object' || Array.isArray(chat)) continue;
                    const isStub = chat._stub === true;
                    const hasMessage = Array.isArray(chat.message);
                    if (isStub && !hasMessage) continue; // real stub: no payload
                    const plan = planFix(chat);
                    if (plan.hybrid || plan.newId) fixes.push([chat, plan]);
                    const chatId = plan.obj.id;
                    const bytes = encodeMsgpackOwned(plan.obj);
                    const old = loaded ? chars.get(char.chaId)?.get(chatId) : undefined;
                    const body = old && old.body.bytes.equals(bytes) ? old.body : makeBody(plan.obj, bytes);
                    mapFor(next, char.chaId).set(chatId, {
                        body,
                        wseq: old && body === old.body ? old.wseq : 0,
                        onDisk: true,
                    });
                }
            }
            restorePendingInto(next, false);
            if (pendingOverridesBodilessStubsOf) {
                const diskChars = Array.isArray(pendingOverridesBodilessStubsOf.characters)
                    ? pendingOverridesBodilessStubsOf.characters
                    : [];
                const seen = new Set();
                for (const { chaId, chatId, chat } of pendingChatPayloads.entries()) {
                    const key = pairKey(chaId, chatId);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const diskChats = diskChars.find((c) => c?.chaId === chaId)?.chats;
                    if (!Array.isArray(diskChats)) continue;
                    const onDisk = diskChats.find((c) => c?.id === chatId);
                    if (!onDisk || onDisk._stub !== true || Array.isArray(onDisk.message)) continue;
                    mapFor(next, chaId).set(chatId, { body: makeBody(chat), wseq: 0, onDisk: false });
                }
            }
            if (loaded) {
                for (const [chaId, m] of chars) {
                    for (const [chatId, entry] of m) {
                        if (!entry.onDisk) mapFor(next, chaId).set(chatId, entry);
                    }
                }
            }
            // ── nothing below can throw ──
            if (fixInPlace) for (const [chat, plan] of fixes) applyFixInPlace(chat, plan);
            chars = next;
            registeredAt = new Map();
            charRev = new Map();
            loadRev = ++rev;
            noopMerged = new WeakMap();
            loaded = true;
        },

        // Drop everything (the database was replaced). Tokens taken before
        // become stale.
        reset() {
            chars = new Map();
            registeredAt = new Map();
            charRev = new Map();
            loadRev = ++rev;
            noopMerged = new WeakMap();
            loaded = false;
            storeId++;
        },

        // ── reads (throw CHAT_STORE_NOT_LOADED when not loaded) ─────────────

        has(chaId, chatId) {
            return entryOf(chaId, chatId) !== undefined;
        },
        hasCharacter(chaId) {
            assertLoaded();
            return chars.has(chaId);
        },
        characterIds() {
            assertLoaded();
            return Array.from(chars.keys());
        },
        chatIds(chaId) {
            assertLoaded();
            return Array.from(chars.get(chaId)?.keys() ?? []);
        },
        /** Fresh decode, owned by the caller. */
        getChat(chaId, chatId) {
            const body = bodyOf(chaId, chatId);
            return body ? unpackr.decode(body.bytes) : undefined;
        },
        /** packr.encode(body): the store's own Buffer, read-only (see the identity contract above). */
        getEncoded(chaId, chatId) {
            return bodyOf(chaId, chatId)?.bytes;
        },
        /** An integer that changes iff getEncoded's Buffer identity changes. */
        bodyVersion(chaId, chatId) {
            return bodyOf(chaId, chatId)?.ver;
        },
        isOnDisk(chaId, chatId) {
            return entryOf(chaId, chatId)?.onDisk;
        },
        /**
         * The disk bytes of a catalog stub: exactly
         * packr.encode(mergeChatStubWithFullChat(stub, getChat(chaId, stub.id))).
         * reused: the bytes are the stored Buffer itself (the merge is a no-op).
         * hasMessageArray: Array.isArray(merged.message).
         */
        encodeMerged(chaId, stub) {
            const body = bodyOf(chaId, stub?.id);
            if (!body) return undefined;
            if (mergeIsNoop(body.meta, stub)) {
                return { bytes: body.bytes, reused: true, hasMessageArray: body.hasMessageArray };
            }
            const merged = mergeChatStubWithFullChat(stub, unpackr.decode(body.bytes));
            return { bytes: encodeMsgpackOwned(merged), reused: false, hasMessageArray: Array.isArray(merged.message) };
        },
        /**
         * Object path (reassembleFullDb): mergeChatStubWithFullChat(stub, a
         * fresh decode of the body), or undefined when there is no body.
         */
        getMergedChat(chaId, stub) {
            const body = bodyOf(chaId, stub?.id);
            if (!body) return undefined;
            const merged = mergeChatStubWithFullChat(stub, unpackr.decode(body.bytes));
            if (mergeIsNoop(body.meta, stub)) noopMerged.set(merged, body);
            if (testHardening) deepFreeze(merged);
            return merged;
        },
        /**
         * Persist path (reassembleFullDb for a database that is only
         * guarded, encoded and handed to acceptPersistedDatabase): a stub
         * whose merge is a no-op comes back as a StoredChatBytes, which
         * encodes as the stored bytes; any other merge as getMergedChat.
         */
        getMergedChatForDisk(chaId, stub) {
            const body = bodyOf(chaId, stub?.id);
            if (!body) return undefined;
            if (stub._stub && mergeIsNoop(body.meta, stub)) return new StoredChatBytes(body, stub.id);
            return store.getMergedChat(chaId, stub);
        },
        /** computeChatEtag of the body, cached per body. */
        etag(chaId, chatId) {
            const body = bodyOf(chaId, chatId);
            if (!body) return undefined;
            if (body.etag === null) body.etag = computeChatEtag(unpackr.decode(body.bytes));
            return body.etag;
        },
        /** md5 of encodeRisuSaveLegacy(body): the legacy byte ETag, cached per body. */
        bufferEtag(chaId, chatId) {
            const body = bodyOf(chaId, chatId);
            if (!body) return undefined;
            if (body.md5 === null) body.md5 = md5Hex(LEGACY_MAGIC, body.bytes);
            return body.md5;
        },
        /** encodeRisuSaveLegacy(body) as a new Buffer (a response body). */
        legacyEncoded(chaId, chatId) {
            const body = bodyOf(chaId, chatId);
            return body ? Buffer.concat([LEGACY_MAGIC, body.bytes]) : undefined;
        },
        /** acceptsChatEtag(expected, body) without decoding twice. */
        acceptsEtag(chaId, chatId, expected) {
            if (typeof expected !== 'string' || !store.has(chaId, chatId)) return false;
            return expected === store.etag(chaId, chatId) || expected === store.bufferEtag(chaId, chatId);
        },
        isColdStorage(chaId, chatId) {
            return !!bodyOf(chaId, chatId)?.cold;
        },
        /** JSON.stringify(body).length (0 when it cannot be serialized), cached. */
        jsonLength(chaId, chatId) {
            const body = bodyOf(chaId, chatId);
            if (!body) return 0;
            if (body.jsonLength === null) {
                try { body.jsonLength = JSON.stringify(unpackr.decode(body.bytes)).length; }
                catch { body.jsonLength = 0; }
            }
            return body.jsonLength;
        },
        /**
         * Character-level revision: changes whenever the set of (chatId,
         * body Buffer) of that character changes, on replaceCharacter, and
         * for every character on each load and reset. Process-monotonic.
         */
        revision(chaId) {
            return charRev.get(chaId) ?? loadRev;
        },
        /**
         * Same counts as running countInChats(refCounts, [body]) over every
         * body, decoding only bodies whose bytes contain "{{inlay".
         */
        scanInlayRefs(refCounts, countInChats) {
            assertLoaded();
            let chatCount = 0;
            let totalMessages = 0;
            for (const m of chars.values()) {
                for (const entry of m.values()) {
                    chatCount++;
                    const body = intact(entry.body);
                    if (body.bytes.indexOf(INLAY_MARKER) === -1) totalMessages += body.stringMessages;
                    else totalMessages += countInChats(refCounts, [unpackr.decode(body.bytes)]);
                }
            }
            return { chats: chatCount, totalMessages };
        },
        stats() {
            if (!loaded) return null;
            let chats = 0;
            let bytes = 0;
            let dirty = 0;
            for (const m of chars.values()) {
                for (const entry of m.values()) {
                    chats++;
                    bytes += entry.body.byteLength;
                    if (!entry.onDisk) dirty++;
                }
            }
            return { characters: chars.size, chats, bytes, dirty, storeId, wseq, testHardening };
        },

        // ── writes (client-originated: each bumps wseq) ────────────────────

        /** Encode a body. May throw; changes nothing. `etag`: computeChatEtag(chat), if the caller has it. */
        prepare(chat, { etag = null } = {}) {
            const body = makeBody(chat);
            if (typeof etag === 'string') body.etag = etag;
            return { body };
        },
        /** Install a prepared body. Cannot fail. */
        commit(chaId, chatId, prepared) {
            assertLoaded();
            const current = chars.get(chaId)?.get(chatId);
            let body = prepared.body;
            if (current && current.body.bytes.equals(body.bytes)) {
                if (current.body.etag === null && body.etag !== null) current.body.etag = body.etag;
                body = current.body;
            }
            mapFor(chars, chaId).set(chatId, { body, wseq: ++wseq, onDisk: false });
            if (!current || current.body !== body) bumpRev(chaId);
        },
        setChat(chaId, chatId, chat) {
            store.commit(chaId, chatId, store.prepare(chat));
        },
        /**
         * /activate: the character's bodies, as a new map (possibly empty,
         * which still registers the character until the next persist).
         */
        replaceCharacter(chaId, chats) {
            assertLoaded();
            const bodies = [];
            for (const chat of chats ?? []) {
                if (!chat || typeof chat !== 'object' || chat._stub === true || !Array.isArray(chat.message)) continue;
                bodies.push([chat.id, makeBody(chat)]);
            }
            const w = ++wseq;
            const m = new Map();
            for (const [chatId, body] of bodies) m.set(chatId, { body, wseq: w, onDisk: false });
            chars.set(chaId, m);
            registeredAt.set(chaId, w);
            bumpRev(chaId);
        },

        // ── persist hooks ──────────────────────────────────────────────────

        /**
         * Byte path, before the blob is written: refuse a plan that would
         * write a bodiless stub for a chat whose body the store holds
         * (CHAT_BODY_DROP), or copy bytes for a chat whose body changed since
         * they were recorded (source 'span', PERSIST_SPAN_STALE).
         */
        assertPersistComplete({ root, written }) {
            assertLoaded();
            const w = new Map();
            for (const x of written ?? []) w.set(pairKey(x.chaId, x.chatId), x);
            for (const x of w.values()) {
                if (x.source !== 'span') continue;
                const entry = chars.get(x.chaId)?.get(x.chatId);
                if (entry && entry.body.bytes !== x.bytes) {
                    throw storeError('PERSIST_SPAN_STALE', `persist aborted: copied bytes of ${x.chaId}/${x.chatId} are older than its body`);
                }
            }
            for (const char of Array.isArray(root?.characters) ? root.characters : []) {
                if (!char?.chaId || !Array.isArray(char.chats)) continue;
                for (const chat of char.chats) {
                    if (chat?._stub !== true || !chat.id || Array.isArray(chat.message)) continue;
                    if (!chars.get(char.chaId)?.has(chat.id)) continue;
                    if (!w.has(pairKey(char.chaId, chat.id))) {
                        throw storeError('CHAT_BODY_DROP', `persist aborted: body of ${char.chaId}/${chat.id} would be dropped`);
                    }
                }
            }
        },

        /**
         * Byte path, after the blob was written. `written` lists every chat
         * written with a body: { chaId, chatId, bytes, source? } where bytes
         * are exactly the bytes written (the stored Buffer for a copied or
         * no-op chat). `root` is the catalog that was written.
         *
         * Per entry, by wseq: bytes equal to the stored body -> marked on
         * disk; an entry committed after the token -> kept (still unwritten);
         * copied ('span') bytes that differ -> refused, the entry stays
         * unwritten; otherwise the written bytes are installed (hybrid flag
         * dropped). Entries not written: newer than the token or journaled ->
         * kept; still listed by the catalog -> kept and marked unwritten
         * (assertPersistComplete should have stopped that); otherwise the
         * chat is gone from disk and the body is dropped.
         * All or nothing: every item is decoded and checked before anything
         * changes, and the journal is retired only after that.
         * A token from before a reset() makes this a no-op.
         */
        acceptPersisted({ token, root, written }) {
            if (!loaded || !token || token.storeId !== storeId) return { stale: true };
            const w = new Map();
            for (const x of written ?? []) w.set(pairKey(x.chaId, x.chatId), x);
            const next = cloneChars();
            const changed = new Set();
            const retire = [];
            let installed = 0, marked = 0, refused = 0, deleted = 0;
            for (const [key, x] of w) {
                if (!Buffer.isBuffer(x.bytes) && !(x.bytes instanceof Uint8Array)) {
                    throw storeError('CHAT_STORE_BAD_WRITTEN', `written item ${key} has no bytes`);
                }
                const entry = next.get(x.chaId)?.get(x.chatId);
                if (entry && (entry.body.bytes === x.bytes || intact(entry.body).bytes.equals(x.bytes))) {
                    // What was written is exactly this body, whenever it was committed.
                    if (!entry.onDisk) next.get(x.chaId).set(x.chatId, { ...entry, onDisk: true });
                    if (entry.body.hasMessageArray) retire.push(x);
                    marked++;
                    continue;
                }
                if (entry && entry.wseq > token.wseq) continue;
                if (entry && x.source === 'span') {
                    logger.error(`[ChatStore] refused stale copied bytes for ${x.chaId}/${x.chatId}`);
                    next.get(x.chaId).set(x.chatId, { ...entry, onDisk: false });
                    refused++;
                    continue;
                }
                const obj = unpackr.decode(x.bytes);
                if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
                    throw storeError('CHAT_STORE_BAD_WRITTEN', `written item ${key} is not a chat`);
                }
                const hybrid = obj._stub === true;
                if (hybrid) delete obj._stub;
                const body = hybrid ? makeBody(obj) : makeBody(obj, x.bytes);
                mapFor(next, x.chaId).set(x.chatId, { body, wseq: entry ? entry.wseq : 0, onDisk: true });
                changed.add(x.chaId);
                if (!hybrid && body.hasMessageArray) retire.push(x);
                installed++;
            }
            const referenced = new Set();
            for (const char of Array.isArray(root?.characters) ? root.characters : []) {
                if (!char?.chaId || !Array.isArray(char.chats)) continue;
                for (const chat of char.chats) if (chat?.id) referenced.add(pairKey(char.chaId, chat.id));
            }
            const pending = pendingPairs();
            for (const [chaId, m] of next) {
                for (const [chatId, entry] of m) {
                    const key = pairKey(chaId, chatId);
                    if (w.has(key) || entry.wseq > token.wseq || pending.has(key)) continue;
                    if (referenced.has(key)) {
                        logger.error(`[ChatStore] ${chaId}/${chatId} is in the catalog but was not written with its body`);
                        if (entry.onDisk) m.set(chatId, { ...entry, onDisk: false });
                        continue;
                    }
                    m.delete(chatId);
                    changed.add(chaId);
                    deleted++;
                }
                if (m.size === 0 && !((registeredAt.get(chaId) ?? 0) > token.wseq)) {
                    next.delete(chaId);
                    changed.add(chaId);
                }
            }
            for (const chaId of restorePendingInto(next, true)) changed.add(chaId);
            pendingChatPayloads.retireCommittedPairs(retire);
            // ── nothing below can throw ──
            chars = next;
            for (const chaId of Array.from(registeredAt.keys())) if (!next.has(chaId)) registeredAt.delete(chaId);
            for (const chaId of changed) bumpRev(chaId);
            return { stale: false, installed, marked, refused, deleted, retired: retire.length };
        },

        /**
         * Object path: `fullDb` is the database object that was just encoded
         * and written, synchronously after `token` was taken. Same outcome
         * as the old `pendingChatPayloads.retireCommitted(fullDb);
         * initChatStore(fullDb)` for everything in fullDb, with these
         * differences:
         *  - `fixInPlace` false (fullDb shares chat objects with a dbCache
         *    root, which must never be mutated): the hybrid and missing-id
         *    fixes go to the store's copy only. true: fullDb is a fresh
         *    decode the caller strips next, so they are made on it as well;
         *  - `prune` false (the no-cache branches, whose fullDb is the disk
         *    catalog rather than the live one): nothing is dropped;
         *  - unchanged bodies keep their Buffer (and cached ETags): a
         *    StoredChatBytes (getMergedChatForDisk) is its stored body, a
         *    chat merged by getMergedChat without changes is recognized
         *    without encoding, anything else is encoded and compared;
         *  - bodies committed after the token, and journaled ones, are kept.
         * A stale token throws (CHAT_STORE_STALE): in a synchronous persist
         * nothing may reset the store between the token and the write.
         */
        acceptPersistedDatabase(fullDb, token, { fixInPlace = false, prune = true } = {}) {
            if (!loaded || !token || token.storeId !== storeId) {
                throw storeError('CHAT_STORE_STALE', 'chat body store was replaced during a database write');
            }
            const next = cloneChars();
            const changed = new Set();
            const fixes = [];
            const written = new Set();
            const referenced = new Set();
            let storedBytes = false;
            for (const char of fullDb?.characters ?? []) {
                if (!char?.chaId || !char.chats) continue;
                for (const chat of char.chats) {
                    if (!chat || typeof chat !== 'object' || Array.isArray(chat)) continue;
                    if (chat instanceof StoredChatBytes) {
                        // Written as exactly this body's bytes.
                        storedBytes = true;
                        const key = pairKey(char.chaId, chat.id);
                        referenced.add(key);
                        written.add(key);
                        const entry = next.get(char.chaId)?.get(chat.id);
                        if (entry && entry.wseq > token.wseq) continue;
                        if (entry && entry.body === chat.body && entry.onDisk) continue;
                        mapFor(next, char.chaId).set(chat.id, { body: chat.body, wseq: entry ? entry.wseq : 0, onDisk: true });
                        if (!entry || entry.body !== chat.body) changed.add(char.chaId);
                        continue;
                    }
                    const isStub = chat._stub === true;
                    const hasMessage = Array.isArray(chat.message);
                    if (isStub && !hasMessage) {
                        if (chat.id) referenced.add(pairKey(char.chaId, chat.id));
                        continue;
                    }
                    const plan = planFix(chat);
                    if (plan.hybrid || plan.newId) fixes.push([chat, plan]);
                    const chatId = plan.obj.id;
                    const key = pairKey(char.chaId, chatId);
                    referenced.add(key);
                    written.add(key);
                    const entry = next.get(char.chaId)?.get(chatId);
                    if (entry && entry.wseq > token.wseq) continue;
                    let body = null;
                    if (entry && plan.obj === chat && noopMerged.get(chat) === entry.body) {
                        body = entry.body;
                    } else {
                        const bytes = encodeMsgpackOwned(plan.obj);
                        body = entry && intact(entry.body).bytes.equals(bytes) ? entry.body : makeBody(plan.obj, bytes);
                    }
                    if (entry && entry.body === body && entry.onDisk) continue;
                    mapFor(next, char.chaId).set(chatId, { body, wseq: entry ? entry.wseq : 0, onDisk: true });
                    if (!entry || entry.body !== body) changed.add(char.chaId);
                }
            }
            if (prune) {
                const pending = pendingPairs();
                for (const [chaId, m] of next) {
                    for (const [chatId, entry] of m) {
                        const key = pairKey(chaId, chatId);
                        if (written.has(key) || entry.wseq > token.wseq || pending.has(key)) continue;
                        if (referenced.has(key)) {
                            logger.error(`[ChatStore] ${chaId}/${chatId} is in the catalog but was not written with its body`);
                            if (entry.onDisk) m.set(chatId, { ...entry, onDisk: false });
                            continue;
                        }
                        m.delete(chatId);
                        changed.add(chaId);
                    }
                    if (m.size === 0 && !((registeredAt.get(chaId) ?? 0) > token.wseq)) {
                        next.delete(chaId);
                        changed.add(chaId);
                    }
                }
            }
            for (const chaId of restorePendingInto(next, true)) changed.add(chaId);
            // Before the fixes, as before: a hybrid on disk keeps its journal row.
            pendingChatPayloads.retireCommitted(storedBytes ? retireView(fullDb) : fullDb);
            // ── nothing below can throw ──
            if (fixInPlace) for (const [chat, plan] of fixes) applyFixInPlace(chat, plan);
            chars = next;
            for (const chaId of Array.from(registeredAt.keys())) if (!next.has(chaId)) registeredAt.delete(chaId);
            for (const chaId of changed) bumpRev(chaId);
            return { stale: false };
        },
    };
    return store;
}

module.exports = {
    createChatBodyStore,
    chatToStub,
    mergeChatStubWithFullChat,
    mergeIsNoop,
    captureMeta,
    deepFreeze,
    StoredChatBytes,
    STORED_CHAT_EXT_TYPE,
    LEGACY_MAGIC,
};
