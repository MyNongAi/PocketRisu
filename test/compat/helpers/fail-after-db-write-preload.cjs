// Test-only fault injection, loaded into the server via NODE_OPTIONS=--require.
// While a `fail-after-db-write` file exists in the server's cwd, the pending
// chat journal's retireCommitted() throws. Every database.bin writer calls it
// right after kvSet, so this is a failure after the blob was committed (disk
// already holds the new bytes, memory has not caught up yet). The byte path
// (ChatBodyStore.acceptPersisted after a planned persist) retires through
// retireCommittedPairs, which fails the same way.
const path = require('node:path');
const fs = require('node:fs');
const journal = require('../../../server/node/pending-chat-payloads.cjs');

const original = journal.createPendingChatPayloads;
journal.createPendingChatPayloads = (...args) => {
    const payloads = original(...args);
    const retireCommitted = payloads.retireCommitted;
    payloads.retireCommitted = (...rest) => {
        if (fs.existsSync(path.join(process.cwd(), 'fail-after-db-write'))) {
            throw new Error('injected failure after the database.bin write');
        }
        return retireCommitted(...rest);
    };
    const retireCommittedPairs = payloads.retireCommittedPairs;
    payloads.retireCommittedPairs = (...rest) => {
        if (fs.existsSync(path.join(process.cwd(), 'fail-after-db-write'))) {
            throw new Error('injected failure after the database.bin write');
        }
        return retireCommittedPairs(...rest);
    };
    return payloads;
};
