'use strict';
// The server's side of the laptop's remote switch (pocketrisu-remote-switch.cjs,
// kept outside the repo next to the launcher on the server laptop):
//
// - When someone last used the app, for the switch's night-time sleep. An open
//   tab keeps its event streams and a few polls going on its own, so those do
//   not count; any other request counts from its start to its end, so a long
//   generation or import keeps the laptop up while it runs.
// - The sidebar's reload button asks the switch to run the launcher (stop,
//   pull, build if needed, start) the same way the desktop's PocketRisu button
//   does, then the page reloads into whatever the laptop now serves.
const http = require('http');
const path = require('path');

// Requests an untouched open tab, or the switch itself, sends.
const BACKGROUND_PATHS = [
    /^\/api\/sync\/events$/,
    /^\/api\/import\/watch-downloads$/,
    /^\/api\/chat-session\/[^/]+\/[^/]+\/claim$/,
    /^\/api\/session\/lock-status$/,
    /^\/api\/token\/refresh$/,
    /^\/api\/laptop\/activity$/,
    /^\/build-id\.txt$/,
];

function isBackgroundRequest(requestPath) {
    const p = String(requestPath || '');
    return BACKGROUND_PATHS.some((pattern) => pattern.test(p));
}

function createUseTracker({ now = Date.now } = {}) {
    let lastUseAt = now();
    let inFlight = 0;
    return {
        middleware(req, res, next) {
            if (!isBackgroundRequest(req.path)) {
                lastUseAt = now();
                inFlight++;
                res.once('close', () => {
                    inFlight--;
                    lastUseAt = now();
                });
            }
            next();
        },
        snapshot() {
            return { lastUseAt, inFlight, now: now() };
        },
    };
}

const DEFAULT_SWITCH_URL = 'http://127.0.0.1:6010';

/**
 * Ask the switch to run the launcher. The switch only manages the install it
 * sits next to, so it is told which folder this server runs from and refuses
 * any other (a test server on another port must never restart the real one).
 * Resolves { status, body }; status 0 when the switch is not there.
 */
function requestLaptopRestart({ switchUrl = DEFAULT_SWITCH_URL, root = process.cwd(), timeoutMs = 5000 } = {}) {
    return new Promise((resolve) => {
        let target;
        try { target = new URL('/restart', switchUrl); } catch { resolve({ status: 0, body: null }); return; }
        const req = http.request(target, {
            method: 'POST',
            headers: {
                'X-PocketRisu-Remote': '1',
                'X-PocketRisu-Root': encodeURIComponent(path.resolve(root)),
                'X-PocketRisu-Who': 'app reload button',
            },
            timeout: timeoutMs,
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => {
                let body = null;
                try { body = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: res.statusCode || 0, body });
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null }); });
        req.on('error', () => resolve({ status: 0, body: null }));
        req.end();
    });
}

module.exports = { isBackgroundRequest, createUseTracker, requestLaptopRestart, DEFAULT_SWITCH_URL };
