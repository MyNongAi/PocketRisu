'use strict';

// Short-lived, per-chat generation leases.
//
// The database itself remains optimistically versioned, but model requests are
// expensive: discovering a same-chat conflict only after the reply finishes is
// a miserable UX. A lease rejects only another page/device trying to generate
// into the SAME chat. Different chats never share a key and remain concurrent.
function createChatSessionLock(opts = {}) {
    const now = opts.now || Date.now;
    const ttlMs = Math.max(1_000, Number(opts.ttlMs) || 3 * 60 * 1000);
    const leases = new Map(); // chatKey -> { clientId, sessionId, updatedAt }

    function liveLease(key) {
        const lease = leases.get(key);
        if (!lease) return null;
        if (now() - lease.updatedAt >= ttlMs) {
            leases.delete(key);
            return null;
        }
        return lease;
    }

    function claim(key, clientId, sessionId = '') {
        if (!key || !clientId) return { ok: false, reason: 'invalid-client' };
        const current = liveLease(key);
        if (current && current.clientId !== clientId) {
            return {
                ok: false,
                reason: 'busy',
                retryAfterMs: Math.max(0, ttlMs - (now() - current.updatedAt)),
            };
        }
        const renewed = !!current;
        leases.set(key, { clientId, sessionId, updatedAt: now() });
        return { ok: true, renewed, expiresInMs: ttlMs };
    }

    // A normal chat edit is allowed when nobody is generating. While a lease
    // exists, only its owning page may save that chat; ETag checks still run
    // afterwards and protect against older/unmodified clients.
    function checkWrite(key, clientId) {
        const current = liveLease(key);
        if (!current) return { ok: true };
        if (current.clientId !== clientId) {
            return { ok: false, reason: 'busy' };
        }
        current.updatedAt = now();
        return { ok: true, leased: true };
    }

    function release(key, clientId) {
        const current = liveLease(key);
        if (!current || current.clientId !== clientId) return { released: false };
        leases.delete(key);
        return { released: true };
    }

    function activeCount() {
        for (const key of leases.keys()) liveLease(key);
        return leases.size;
    }

    return { claim, checkWrite, release, activeCount };
}

module.exports = { createChatSessionLock };
