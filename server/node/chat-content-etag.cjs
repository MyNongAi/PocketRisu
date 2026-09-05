'use strict';

const { createHash } = require('node:crypto');
const { normalizeJSON, encodeRisuSaveLegacy } = require('./utils.cjs');

// These fields belong to the catalog and are guarded by the database PATCH
// precondition, not the chat-body precondition. A delayed catalog persist must
// not invalidate a successful body save. Keep in sync with chatToStub.
const CATALOG_FIELDS = new Set(['name', 'lastDate', 'folderId', 'modules', '_stub', '_placeholder']);

function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
    }
    return value;
}

function computeChatEtag(chat) {
    const payload = Object.fromEntries(Object.entries(chat).filter(([key]) => !CATALOG_FIELDS.has(key)));
    const canonical = sortKeys(normalizeJSON(payload));
    return 'chat-v2-' + createHash('sha256').update(Buffer.from(encodeRisuSaveLegacy(canonical))).digest('hex');
}

// Existing tabs can upgrade using their old byte-based ETag only if it still
// describes the current full payload. Never bless an arbitrary stale version.
function acceptsChatEtag(expected, chat) {
    if (!chat || typeof expected !== 'string') return false;
    if (expected === computeChatEtag(chat)) return true;
    return expected === createHash('md5').update(Buffer.from(encodeRisuSaveLegacy(chat))).digest('hex');
}

module.exports = { computeChatEtag, acceptsChatEtag };
