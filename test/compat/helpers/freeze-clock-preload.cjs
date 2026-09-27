// Test-only clock, loaded into the server via NODE_OPTIONS=--require.
// While a `freeze-clock` file exists in the server's cwd, Date.now() returns
// the millisecond timestamp it holds, so things the server does one after
// another fall in the same instant (e.g. two snapshots in one 100 ms tick).
const path = require('node:path');
const fs = require('node:fs');

const realNow = Date.now;
const flag = path.join(process.cwd(), 'freeze-clock');
Date.now = () => {
    if (!fs.existsSync(flag)) return realNow();
    try {
        return Number(fs.readFileSync(flag, 'utf-8')) || realNow();
    } catch {
        return realNow();
    }
};
