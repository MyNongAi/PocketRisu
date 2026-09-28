// Test-only fault injection, loaded into the server via NODE_OPTIONS=--require.
// While a `fail-db-persist` file exists in the server's cwd, every kvSet of
// database/database.bin throws — a persist that fails (disk full, size limit)
// while the rest of storage keeps working. The persister's chunk commit and
// raw write of the blob (db.cjs dbBlob) fail the same way, so every persist
// mode sees the same failure.
const path = require('node:path');
const fs = require('node:fs');
const db = require('../../../server/node/db.cjs');

const original = db.kvSet;
db.kvSet = (key, ...rest) => {
    if (key === 'database/database.bin' && fs.existsSync(path.join(process.cwd(), 'fail-db-persist'))) {
        throw new Error('injected database.bin persist failure');
    }
    return original(key, ...rest);
};

const failing = () => fs.existsSync(path.join(process.cwd(), 'fail-db-persist'));
for (const name of ['commitChunks', 'putValue']) {
    const blobMethod = db.dbBlob[name];
    db.dbBlob[name] = (...args) => {
        if (failing()) throw new Error('injected database.bin persist failure');
        return blobMethod(...args);
    };
}
