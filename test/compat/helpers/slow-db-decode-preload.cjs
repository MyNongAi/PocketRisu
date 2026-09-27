// Test-only delay, loaded into the server via NODE_OPTIONS=--require.
// When a `slow-db-decode` file exists in the server's cwd, the next decode of
// a whole database (an object with a `characters` array) takes that many
// extra milliseconds (the file's content; 1500 when empty). The file is
// removed by that decode, so only one decode waits: the one that started
// first, e.g. a flush decoding the blob, while a request that lands during
// the wait decodes at full speed.
const path = require('node:path');
const fs = require('node:fs');
const utils = require('../../../server/node/utils.cjs');

const original = utils.decodeRisuSave;
utils.decodeRisuSave = async (...args) => {
    const decoded = await original(...args);
    const flag = path.join(process.cwd(), 'slow-db-decode');
    if (decoded && typeof decoded === 'object' && Array.isArray(decoded.characters) && fs.existsSync(flag)) {
        const ms = Number(fs.readFileSync(flag, 'utf-8')) || 1500;
        fs.rmSync(flag, { force: true });
        await new Promise((resolve) => setTimeout(resolve, ms));
    }
    return decoded;
};
