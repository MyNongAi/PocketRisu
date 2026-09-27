'use strict';

const { Packr, Unpackr } = require('msgpackr');
const PREFIX = 'chat-payload-pending/';
const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false, int64AsType: 'number' });

// Chat creation is a two-request protocol: body first, catalog entry second.
// Journal the body until the catalog and body have reached database.bin together.
// This is deliberately NOT a second copy of every chat or an asset cache.
// A database persist lists the journal (pairs, from the keys alone) and
// decodes it only for retireCommitted and when the chat store lacks a
// journaled body, so kvList should be an index-backed exact prefix scan
// (db.cjs kvListExactPrefix), not a LIKE scan of every kv row.
function createPendingChatPayloads({ kvGet, kvSet, kvDel, kvList, kvExists = (key) => kvGet(key) !== null }) {
    const keyFor = (chaId, chatId) => PREFIX + Buffer.from(JSON.stringify([chaId, chatId])).toString('hex');
    function stage(chaId, chatId, chat) {
        kvSet(keyFor(chaId, chatId), Buffer.from(packr.pack({ chaId, chatId, chat })));
    }
    // Every record, decoded and checked. Throws on an invalid one (the
    // record is left alone for manual recovery).
    function entries() {
        return kvList(PREFIX).map(key => {
            const record = unpackr.unpack(kvGet(key));
            if (!record?.chaId || !record?.chatId || record.chat?.id !== record.chatId
                || !Array.isArray(record.chat.message) || keyFor(record.chaId, record.chatId) !== key) {
                throw new Error('Invalid pending chat payload; recovery record was left intact');
            }
            return { key, ...record };
        });
    }
    return {
        stage,
        entries,
        has: (chaId, chatId) => kvExists(keyFor(chaId, chatId)),
        // [chaId, chatId] of every journaled chat, from the keys alone (no
        // record is read or decoded). A key that does not parse is skipped:
        // it names no chat, and entries() still reports it.
        pairs() {
            const out = [];
            for (const key of kvList(PREFIX)) {
                try {
                    const pair = JSON.parse(Buffer.from(key.slice(PREFIX.length), 'hex').toString('utf8'));
                    if (Array.isArray(pair) && pair.length === 2) out.push(pair);
                } catch { /* not a journal key of ours */ }
            }
            return out;
        },
        retireCommitted(database) {
            for (const { key, chaId, chatId } of entries()) {
                const chat = database?.characters?.find(c => c?.chaId === chaId)?.chats?.find(c => c?.id === chatId);
                // Only called AFTER database.bin was successfully written.
                if (Array.isArray(chat?.message) && !chat._stub) kvDel(key);
            }
        },
        // Byte-path twin of retireCommitted: the caller already knows which
        // chats were written with a message and without `_stub`. Only called
        // AFTER database.bin was successfully written.
        retireCommittedPairs(list) {
            for (const { chaId, chatId } of list ?? []) {
                const key = keyFor(chaId, chatId);
                if (kvExists(key)) kvDel(key);
            }
        },
    };
}

module.exports = { createPendingChatPayloads };
