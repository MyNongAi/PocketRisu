// Test-only, loaded into the server via NODE_OPTIONS=--require: the boot
// payload planner starts disabled, as after a failed self-test or a
// detected in-place change. Reads then encode the whole view (md5 etag) and
// /api/db/boot answers 503 BOOT_DISABLED.
const bootPayload = require('../../../server/node/boot-payload.cjs');

const original = bootPayload.createBootPayloadPlanner;
bootPayload.createBootPayloadPlanner = (...args) => {
    const planner = original(...args);
    planner.disable('disabled by a test preload');
    return planner;
};
