'use strict';

// Experimental, pure reconciliation for two *independent* PocketRisu saves.
// It deliberately does not move characters, assets, modules, or settings.
// Nothing here is wired to a live server: tests use disposable save folders.
// Different versions of the same chat are preserved as separate rooms instead
// of choosing a winner or silently appending potentially incompatible turns.

const { createHash } = require('node:crypto');

function copy(value) {
    return structuredClone(value);
}

function fingerprint(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function catalog(db) {
    if (!db || !Array.isArray(db.characters)) {
        throw new TypeError('A full database with characters is required');
    }
    const characters = new Map();
    for (const character of db.characters) {
        if (!character || typeof character.chaId !== 'string' || !Array.isArray(character.chats)) {
            throw new TypeError('Each character needs a chaId and chats array');
        }
        if (characters.has(character.chaId)) {
            throw new Error(`Duplicate character id: ${character.chaId}`);
        }
        const chats = new Map();
        for (const chat of character.chats) {
            if (!chat || typeof chat.id !== 'string' || !Array.isArray(chat.message)
                || chat._stub || chat._placeholder) {
                throw new TypeError(`Full chat body required: ${character.chaId}/${chat?.id ?? '?'}`);
            }
            if (chats.has(chat.id)) {
                throw new Error(`Duplicate chat id: ${character.chaId}/${chat.id}`);
            }
            chats.set(chat.id, chat);
        }
        characters.set(character.chaId, { character, chats });
    }
    return characters;
}

function preservedCopy(chat, label) {
    const saved = copy(chat);
    saved.id = `peer-preserved-${fingerprint(chat).slice(0, 24)}`;
    saved.name = `${chat.name || 'Chat'} (conflict preserved: ${label})`;
    return saved;
}

function addIfAbsent(entry, chat) {
    const existing = entry.chats.get(chat.id);
    if (existing) {
        if (fingerprint(existing) !== fingerprint(chat)) {
            throw new Error(`Preserved chat id collision: ${chat.id}`);
        }
        return false;
    }
    entry.character.chats.push(chat);
    entry.chats.set(chat.id, chat);
    return true;
}

/**
 * Return independent, reconciled copies. A chat existing on just one peer is
 * copied to the other peer only when its character id exists on both. When the
 * same chat id has different content, keep both originals untouched and copy
 * each version into a deterministic, additional room on the opposite peer.
 * Re-running without new writes is idempotent. A missing character is skipped
 * because its asset and module dependencies have not been transferred.
 */
function reconcilePeerChats(leftDb, rightDb, labels = { left: 'left', right: 'right' }) {
    const left = copy(leftDb);
    const right = copy(rightDb);
    const leftCharacters = catalog(left);
    const rightCharacters = catalog(right);
    const report = {
        copiedToLeft: 0,
        copiedToRight: 0,
        conflictRooms: 0,
        skippedCharacterIds: [],
    };

    for (const [chaId, leftEntry] of leftCharacters) {
        const rightEntry = rightCharacters.get(chaId);
        if (!rightEntry) {
            report.skippedCharacterIds.push(chaId);
            continue;
        }

        // Snapshot ids before changing either catalog so a newly copied room
        // is never treated as another source in the same reconciliation pass.
        const ids = new Set([...leftEntry.chats.keys(), ...rightEntry.chats.keys()]);
        for (const id of ids) {
            const leftChat = leftEntry.chats.get(id);
            const rightChat = rightEntry.chats.get(id);
            // Each side already has this content under its original id. A
            // preserved room belongs only on the *opposite* side; copying it
            // back would create a duplicate room without adding information.
            if (id.startsWith('peer-preserved-')) {
                if (leftChat && rightChat && fingerprint(leftChat) !== fingerprint(rightChat)) {
                    throw new Error(`Preserved chat changed independently: ${chaId}/${id}`);
                }
                continue;
            }
            if (!leftChat) {
                if (addIfAbsent(leftEntry, copy(rightChat))) report.copiedToLeft++;
            } else if (!rightChat) {
                if (addIfAbsent(rightEntry, copy(leftChat))) report.copiedToRight++;
            } else if (fingerprint(leftChat) !== fingerprint(rightChat)) {
                if (addIfAbsent(leftEntry, preservedCopy(rightChat, labels.right))) {
                    report.copiedToLeft++;
                    report.conflictRooms++;
                }
                if (addIfAbsent(rightEntry, preservedCopy(leftChat, labels.left))) {
                    report.copiedToRight++;
                    report.conflictRooms++;
                }
            }
        }
    }
    for (const chaId of rightCharacters.keys()) {
        if (!leftCharacters.has(chaId)) report.skippedCharacterIds.push(chaId);
    }
    return { left, right, report };
}

module.exports = { reconcilePeerChats };
