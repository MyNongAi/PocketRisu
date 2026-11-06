'use strict';

// Realm search through the reader's own relay.
//
// sv.risuai.xyz can leave NSFW cards out of a search depending on the region
// it comes from, whatever the request asks for. Thumbnails, card info and downloads
// are not filtered, so only the search (`/realm/<query>`) needs another way
// out. The client names a relay it runs (a small reverse proxy in another region,
// reached over Tailscale) in this header; the authenticated relay route sends it to
// `<relay>/sv/realm/...` instead of sv.risuai.xyz.

const { pipeline } = require('node:stream/promises');

const REALM_RELAY_HEADER = 'x-risu-realm-relay';

/**
 * The URL to fetch through `relay`, or null for an invalid relay or search.
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
    const target = new URL(`${prefix}/sv${pathAndQuery}`);
    // URL parsing normalizes dot segments and backslashes. They must not let a
    // search escape /sv/realm/ (including when the relay has a base path).
    if (!target.pathname.startsWith(new URL(`${prefix}/sv/realm/`).pathname)) return null;
    return target.href;
}

// Session authentication is applied by the route before this handler runs.
async function forwardRealmSearch(req, res, { hubOrigin, logger }) {
    try {
        const pathAndQuery = req.originalUrl.replace(/^\/api\/realm-relay/, '');
        const relayURL = realmRelayTarget(req.headers[REALM_RELAY_HEADER], pathAndQuery);
        if (!relayURL) {
            res.status(400).send({ error: 'Invalid Realm relay or search path' });
            return;
        }

        const relayOrigin = new URL(relayURL).origin;
        const headersToSend = { ...req.headers };
        delete headersToSend.host;
        delete headersToSend.connection;
        delete headersToSend['content-length'];
        delete headersToSend['x-risu-node-path'];
        delete headersToSend[REALM_RELAY_HEADER];
        delete headersToSend['risu-auth'];
        delete headersToSend.cookie;
        headersToSend.origin = hubOrigin;

        let target = new URL(relayURL);
        let response;
        for (let redirects = 0; ; redirects++) {
            response = await fetch(target, {
                method: 'GET',
                headers: headersToSend,
                redirect: 'manual',
            });
            const location = response.headers.get('location');
            if (response.status < 300 || response.status >= 400 || !location) break;
            await response.body?.cancel();
            const redirectURL = new URL(location, target);
            if (redirectURL.origin !== relayOrigin) {
                throw new Error('Realm relay redirected to a different origin');
            }
            if (redirects >= 20) throw new Error('Too many Realm relay redirects');
            target = redirectURL;
        }

        const excludedHeaders = ['content-encoding', 'content-length', 'transfer-encoding'];
        for (const [key, value] of response.headers.entries()) {
            if (!excludedHeaders.includes(key.toLowerCase())) res.setHeader(key, value);
        }
        res.status(response.status);
        if (response.body) {
            await pipeline(response.body, res);
        } else {
            res.end();
        }
    } catch (error) {
        logger.error('[Realm Relay] Error:', error);
        if (!res.headersSent) {
            res.status(502).send({ error: 'Realm relay request failed: ' + error.message });
        } else {
            res.end();
        }
    }
}

module.exports = { REALM_RELAY_HEADER, realmRelayTarget, forwardRealmSearch };
