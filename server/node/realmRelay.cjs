'use strict';

// Realm search through the reader's own relay.
//
// sv.risuai.xyz can leave NSFW cards out of a search depending on the region
// it comes from, whatever the request asks for. Thumbnails, card info and downloads
// are not filtered, so only the search (`/realm/<query>`) needs another way
// out. The client names a relay it runs (a small reverse proxy in another region,
// reached over Tailscale) in this header; the hub proxy then sends that one request to
// `<relay>/sv/realm/...` instead of sv.risuai.xyz.

const REALM_RELAY_HEADER = 'x-risu-realm-relay';

/**
 * The URL to fetch for a hub-proxy request through `relay`, or null to use
 * the hub as usual (no relay, a malformed one, or not a Realm search).
 */
function realmRelayTarget(relay, pathAndQuery) {
    if (typeof relay !== 'string' || !relay.trim()) return null;
    if (typeof pathAndQuery !== 'string' || !pathAndQuery.startsWith('/realm/')) return null;
    let base;
    try {
        base = new URL(relay.trim());
    } catch {
        return null;
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
    if (base.username || base.password || base.search || base.hash) return null;
    const prefix = base.href.replace(/\/+$/, '');
    return `${prefix}/sv${pathAndQuery}`;
}

module.exports = { REALM_RELAY_HEADER, realmRelayTarget };
