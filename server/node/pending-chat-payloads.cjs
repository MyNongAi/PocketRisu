'use strict';

const { Packr, Unpackr } = require('msgpackr');
const { isDeepStrictEqual } = require('node:util');
const PREFIX = 'chat-payload-pending/';
const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false, int64AsType: 'number' });

// A chat-content response must not claim success before the body is durable.
// Journal only dirty chat bodies until that exact body reaches database.bin.
// This also covers the two-request chat-creation/catalog protocol.
function createPendingChatPayloads({ kvGet, kvSet, kvDel, kvList }) {
    const keyFor = (chaId, chatId) => PREFIX + Buffer.from(JSON.stringify([chaId, chatId])).toString('hex');
    function stage(chaId, chatId, chat) {
        kvSet(keyFor(chaId, chatId), Buffer.from(packr.pack({ chaId, chatId, chat })));
    }
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
        has: (chaId, chatId) => kvGet(keyFor(chaId, chatId)) !== null,
        restoreInto(store) {
            for (const { chaId, chatId, chat } of entries()) {
                if (!store.has(chaId)) store.set(chaId, new Map());
                // The journal was committed before the success response. A
                // persisted database body may lag behind that acknowledged
                // version after a crash or failed debounced flush.
                store.get(chaId).set(chatId, chat);
            }
        },
        retireCommitted(database) {
            for (const { key, chaId, chatId, chat: stagedChat } of entries()) {
                const chat = database?.characters?.find(c => c?.chaId === chaId)?.chats?.find(c => c?.id === chatId);
                // Only retire after the same body is on disk. A concurrent
                // metadata-only or stale full-DB write cannot discard a newer
                // acknowledged chat update from this journal.
                if (Array.isArray(chat?.message) && !chat._stub
                    && isDeepStrictEqual(chat.message, stagedChat.message)) kvDel(key);
            }
        },
    };
}

module.exports = { createPendingChatPayloads };
