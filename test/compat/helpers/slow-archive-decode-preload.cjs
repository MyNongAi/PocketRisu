// Test-only delay, loaded into the server via NODE_OPTIONS=--require.
// While a `slow-archive-decode` file exists in the server's cwd, decoding a
// character archive row (a payload with `character` and `archivedAt`) takes
// that many extra milliseconds (the file's content; 1500 when empty). This
// holds a database persist inside its await on archive rows long enough for
// other requests to land meanwhile.
const path = require('node:path');
const fs = require('node:fs');
const utils = require('../../../server/node/utils.cjs');

const original = utils.decodeRisuSave;
utils.decodeRisuSave = async (...args) => {
    const decoded = await original(...args);
    const flag = path.join(process.cwd(), 'slow-archive-decode');
    if (decoded && typeof decoded === 'object' && decoded.character && decoded.archivedAt && fs.existsSync(flag)) {
        const ms = Number(fs.readFileSync(flag, 'utf-8')) || 1500;
        await new Promise((resolve) => setTimeout(resolve, ms));
    }
    return decoded;
};
