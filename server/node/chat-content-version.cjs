'use strict';

// Decide whether a per-chat optimistic-concurrency precondition is safe.
// A catalog stub with no payload is not a remote edit: it is the recoverable
// half-state left when the lazy chat body failed to persist. In that one case
// the browser's still-hydrated full chat is the only surviving payload and may
// repopulate the server store. A chat missing from BOTH stores remains deleted.
function evaluateChatVersion(options = {}) {
    const expectedEtag = typeof options.expectedEtag === 'string'
        ? options.expectedEtag
        : '';
    const currentEtag = typeof options.currentEtag === 'string'
        ? options.currentEtag
        : null;
    const repairMissingPayload = !options.hasCurrentPayload && !!options.hasCatalogStub;

    if (repairMissingPayload) {
        return { ok: true, repairMissingPayload: true };
    }
    if (options.renewed || !expectedEtag || expectedEtag === currentEtag) {
        return { ok: true, repairMissingPayload: false };
    }
    return {
        ok: false,
        repairMissingPayload: false,
        reason: currentEtag ? 'changed' : 'missing',
    };
}

module.exports = { evaluateChatVersion };
