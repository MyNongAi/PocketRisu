'use strict';

// Cross-device single-writer session lock.
//
// The app's data model allows exactly one writing client (the in-memory DB is
// synced coarsely — concurrent writers would silently clobber each other).
// This module decides WHICH session holds that write lock, replacing the old
// rule of "the last page load steals it", which produced spurious kicks: a
// phone tab resurrected by the OS (= a page load) would silently take the lock
// from a PC mid-session, and merely glancing at a second device would kick the
// one actually being used.
//
// Rules:
//  - register(id): called at page load. Records the session's boot time but
//    does NOT steal an active lock — opening the app must never kick the
//    device being used. Adopts the lock only when nobody holds it.
//  - checkWrite(id, userActive): called on every data write. The active
//    session passes and refreshes its lastWriteAt. A non-active session takes
//    over IFF BOTH hold:
//      · fresh — it booted AFTER the active session's last accepted write, so
//        its boot loaded the state including that write (cannot clobber), AND
//      · userActive — the client reports a recent user gesture. The app also
//        writes WITHOUT the user doing anything (boot housekeeping, the
//        flush-on-hide keepalive), and an automatic write must never move the
//        lock: a phone tab going to background fires a flush, and that used
//        to steal the lock from the PC actually in use.
//    Fresh but NOT user-active → the write passes WITHOUT taking over (it is
//    fresh, so applying it cannot clobber; rejecting it instead would set off
//    reload loops on boot-time auto-saves). lastWriteAt is not bumped — the
//    lock holder did not write.
//    Stale → still saved. Every database and chat write now carries a version
//    precondition (ETag / patch hash) that catches a stale copy on its own, so
//    refusing a stale session protects nothing and only loses data: on
//    2026-09-24 a phone resuming took the lock, the PC tab in use got a 423 on
//    a draft write, froze its save loop waiting for a reload, and 40 minutes
//    of chat were never saved. A stale session with a user gesture takes the
//    lock back (the device being typed on is the one in use); without a
//    gesture it passes without moving the lock.
//    Strict writes (allowStale: false) keep the old rule — stale → rejected.
//    Only a whole-database or whole-chat overwrite WITHOUT a version check
//    uses it, since that could wipe what another device saved; current
//    clients never send one.
//
// Serial device switching (the single-user pattern) never shows a block, and
// neither does going back to a device left open.
//
// State is in-memory: a server restart clears it and the first write adopts.
function createSessionLock(opts = {}) {
    const now = opts.now || Date.now;
    const MAX_TRACKED_BOOTS = 50;

    let active = null; // { id, lastWriteAt } | null
    const boots = new Map(); // sessionId -> boot timestamp (insertion-ordered)

    function register(id) {
        if (typeof id !== 'string' || id === '') return;
        // Delete-then-set refreshes insertion order so pruning drops the
        // longest-unseen sessions (bounded memory; single-user scale anyway).
        boots.delete(id);
        boots.set(id, now());
        if (boots.size > MAX_TRACKED_BOOTS) {
            boots.delete(boots.keys().next().value);
        }
        if (!active) {
            active = { id, lastWriteAt: now() };
        }
        // A re-register of the CURRENT active id (same-tab reload / OS tab
        // restore, with the client persisting its id) keeps the lock as-is.
    }

    function checkWrite(id, userActive = false, { allowStale = true } = {}) {
        if (typeof id !== 'string' || id === '') {
            return { ok: true }; // client without session support
        }
        if (!active) {
            active = { id, lastWriteAt: now() };
            return { ok: true };
        }
        if (active.id === id) {
            active.lastWriteAt = now();
            return { ok: true };
        }
        const boot = boots.get(id);
        const fresh = boot !== undefined && boot > active.lastWriteAt;
        if (!fresh && !allowStale) {
            return { ok: false };
        }
        if (userActive) {
            active = { id, lastWriteAt: now() };
            return fresh ? { ok: true, tookOver: true } : { ok: true, tookOver: true, reclaimed: true };
        }
        // Automatic write: apply it, but the lock stays where the user
        // actually is.
        return { ok: true, passive: true };
    }

    function activeId() {
        return active ? active.id : null;
    }

    // Side-effect-free view for the client's reload-on-return check.
    // 'stale' is the only state that requires a reload: another session wrote
    // AFTER this one booted, so this one's in-memory copy is outdated.
    // 'fresh' needs nothing — the copy includes every accepted write, and the
    // next user action simply takes the lock over.
    // An id with no recorded boot is 'unknown', NOT 'stale': the boot
    // registration is a separate request that can fail alone on a flaky link
    // (mobile + VPN), and judging such a session stale turns every focus into
    // an automatic reload — a reload loop the client cannot break. Writes are
    // version-checked, so no data is at risk either way.
    function peek(id) {
        if (typeof id !== 'string' || id === '') return 'active';
        if (!active) return 'free';
        if (active.id === id) return 'active';
        const boot = boots.get(id);
        if (boot === undefined) return 'unknown';
        if (boot > active.lastWriteAt) return 'fresh';
        return 'stale';
    }

    return { register, checkWrite, peek, activeId };
}

module.exports = { createSessionLock };
