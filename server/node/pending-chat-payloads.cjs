'use strict';

const { Packr, Unpackr } = require('msgpackr');
const PREFIX = 'chat-payload-pending/';
const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false, int64AsType: 'number' });

// Chat creation is a two-request protocol: body first, catalog entry second.
// Journal the body until the catalog and body have reached database.bin together.
// This is deliberately NOT a second copy of every chat or an asset cache.
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
                if (!store.get(chaId).has(chatId)) store.get(chaId).set(chatId, chat);
            }
        },
        retireCommitted(database) {
            for (const { key, chaId, chatId } of entries()) {
                const chat = database?.characters?.find(c => c?.chaId === chaId)?.chats?.find(c => c?.id === chatId);
                // Only called AFTER database.bin was successfully written.
                if (Array.isArray(chat?.message) && !chat._stub) kvDel(key);
            }
        },
    };
}

module.exports = { createPendingChatPayloads };
