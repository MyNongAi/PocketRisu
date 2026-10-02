'use strict';

// Server reply push (SERVER-REPLY-PUSH): a Web Push notification when a
// server-side model job (model-jobs.cjs) finishes while no page is watching
// it — the phone's app is closed or in the background, so the page itself
// cannot announce the reply. The service worker (public/sw.js) shows it; the
// client toggle lives in src/ts/serverReplyPush.ts.
//
// No `web-push` dependency: both protocol pieces are built on node:crypto.
//   - VAPID (RFC 8292): an ES256 JWT signed with a P-256 key generated once
//     and kept in save/__vapid_private_key.pem, sent as
//     `Authorization: vapid t=<jwt>, k=<public key>`.
//   - Payload encryption (RFC 8291 over the RFC 8188 aes128gcm coding): ECDH
//     with the subscription's p256dh key, HKDF keyed by its auth secret, one
//     AES-128-GCM record.
// The payload holds only a title (character name), a status line (chat name +
// "reply arrived"/"failed") and a tag — never message content — and it is
// end-to-end encrypted, so the push service sees none of it.

const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

const VAPID_KEY_FILE = '__vapid_private_key.pem';
const SUBSCRIPTIONS_FILE = 'push-subscriptions.json';
// RFC 8292 caps the JWT lifetime at 24 h; a fresh token is signed per send.
const VAPID_JWT_TTL_SEC = 12 * 60 * 60;
// A finished reply is not news after half a day.
const PUSH_TTL_SEC = 12 * 60 * 60;
const PUSH_SEND_TIMEOUT_MS = 15 * 1000;
// One record holds the whole payload: plaintext + delimiter + 16-byte tag
// must fit in it (RFC 8291 §4 caps push payloads at 4096 bytes).
const RECORD_SIZE = 4096;
const MAX_SUBSCRIPTIONS = 20;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_TEXT_LENGTH = 120;
const MAX_NAME_LENGTH = 60;
// Apple's push service rejects a JWT without a contact `sub`. Override with
// POCKETRISU_VAPID_SUBJECT (mailto: or https: URL) when self-hosting publicly.
const DEFAULT_VAPID_SUBJECT = 'mailto:pocketrisu@example.com';
// A page that polled the job this recently counts as attached — jobRecovery
// polls a running job at most every 15 s (JOB_POLL_MAX_MS).
const ATTACH_POLL_WINDOW_MS = 20 * 1000;
// How long an attached page gets to collect the finished job (POST claim)
// before the push goes out anyway: a 15 s poll interval plus the slot-in save.
const CLAIM_GRACE_MS = 20 * 1000;
// Fallback text for a subscription stored without the client's localized
// strings (the client always sends them, from src/lang).
const DEFAULT_TEXT = Object.freeze({
    done: '답변이 도착했습니다',
    failed: '답변 생성에 실패했습니다',
});

function base64UrlEncode(buf) {
    return Buffer.from(buf).toString('base64url');
}

function base64UrlDecode(value) {
    return Buffer.from(typeof value === 'string' ? value : '', 'base64url');
}

// Uncompressed P-256 point (0x04 || X || Y) of a private KeyObject — the
// `applicationServerKey` form browsers expect.
function vapidPublicKeyBytes(privateKey) {
    const jwk = nodeCrypto.createPublicKey(privateKey).export({ format: 'jwk' });
    const coord = (value) => {
        const bytes = base64UrlDecode(value);
        return bytes.length >= 32 ? bytes.subarray(bytes.length - 32) : Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
    };
    return Buffer.concat([Buffer.from([0x04]), coord(jwk.x), coord(jwk.y)]);
}

function generateVapidPrivateKey() {
    return nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
}

// ES256 JWT for the push service at `audience` (the endpoint's origin).
function createVapidJwt({ audience, subject, privateKey, now = Date.now(), ttlSec = VAPID_JWT_TTL_SEC }) {
    const header = base64UrlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = base64UrlEncode(JSON.stringify({
        aud: audience,
        exp: Math.floor(now / 1000) + ttlSec,
        sub: subject,
    }));
    const unsigned = `${header}.${claims}`;
    // JWS wants the raw 64-byte r||s signature, not DER.
    const signature = nodeCrypto.sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${unsigned}.${base64UrlEncode(signature)}`;
}

function vapidAuthorization({ endpoint, subject, privateKey, now }) {
    const jwt = createVapidJwt({ audience: new URL(endpoint).origin, subject, privateKey, now });
    return `vapid t=${jwt}, k=${base64UrlEncode(vapidPublicKeyBytes(privateKey))}`;
}

function hkdf(salt, ikm, info, length) {
    return Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, info, length));
}

// RFC 8291 message encryption → the complete aes128gcm request body
// (salt | rs | idlen | keyid=as_public | ciphertext+tag). `options.salt` and
// `options.senderPrivateKey` are test seams for the RFC's fixed vector; real
// sends use a fresh random salt and ephemeral key every time.
function encryptPushPayload(plaintext, keys, options = {}) {
    const uaPublic = base64UrlDecode(keys && keys.p256dh);
    const authSecret = base64UrlDecode(keys && keys.auth);
    if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('Invalid p256dh key');
    if (authSecret.length !== 16) throw new Error('Invalid auth secret');

    const ecdh = nodeCrypto.createECDH('prime256v1');
    if (options.senderPrivateKey) ecdh.setPrivateKey(options.senderPrivateKey);
    else ecdh.generateKeys();
    const asPublic = ecdh.getPublicKey();
    // Throws on a point that is not on the curve (RFC 8291 §7).
    const ecdhSecret = ecdh.computeSecret(uaPublic);
    const salt = options.salt || nodeCrypto.randomBytes(16);

    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
    const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
    const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16);
    const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12);

    // Single (= last) record: payload followed by the 0x02 padding delimiter.
    const record = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])]);
    if (record.length + 16 > RECORD_SIZE) throw new Error('Push payload too large');
    const cipher = nodeCrypto.createCipheriv('aes-128-gcm', cek, nonce);
    const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

    const header = Buffer.alloc(21);
    salt.copy(header, 0);
    header.writeUInt32BE(RECORD_SIZE, 16);
    header.writeUInt8(asPublic.length, 20);
    return Buffer.concat([header, asPublic, ciphertext]);
}

function clipText(value, max) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function normalizeText(input) {
    const pick = (value, fallback) => clipText(value, MAX_TEXT_LENGTH) || fallback;
    return {
        done: pick(input && input.done, DEFAULT_TEXT.done),
        failed: pick(input && input.failed, DEFAULT_TEXT.failed),
    };
}

// Validates a PushSubscription JSON ({ endpoint, keys: { p256dh, auth } }).
function normalizeSubscription(input) {
    const endpoint = input && input.endpoint;
    if (typeof endpoint !== 'string' || !endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) {
        return { error: 'Invalid push endpoint' };
    }
    let parsed;
    try {
        parsed = new URL(endpoint);
    } catch {
        return { error: 'Invalid push endpoint' };
    }
    if (parsed.protocol !== 'https:') return { error: 'Push endpoint must be https' };
    const p256dh = base64UrlDecode(input.keys && input.keys.p256dh);
    const auth = base64UrlDecode(input.keys && input.keys.auth);
    try {
        // Rejects anything that is not a point on P-256.
        nodeCrypto.ECDH.convertKey(p256dh, 'prime256v1', undefined, undefined, 'uncompressed');
    } catch {
        return { error: 'Invalid p256dh key' };
    }
    if (p256dh.length !== 65 || auth.length !== 16) return { error: 'Invalid subscription keys' };
    return { endpoint, keys: { p256dh: base64UrlEncode(p256dh), auth: base64UrlEncode(auth) } };
}

// Subscriptions live in save/push-subscriptions.json: per-device records,
// deliberately outside the kv store so backups/imports never carry another
// device's push endpoint. Written atomically (tmp + rename).
function createPushSubscriptionStore({ filePath, maxEntries = MAX_SUBSCRIPTIONS, logger } = {}) {
    let entries = load();

    function load() {
        let raw;
        try {
            raw = fs.readFileSync(filePath, 'utf-8');
        } catch (err) {
            if (err && err.code !== 'ENOENT' && logger) logger.warn('[Push] could not read subscriptions', err);
            return [];
        }
        try {
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed && parsed.subscriptions) ? parsed.subscriptions : [];
            return list.flatMap((entry) => {
                const sub = normalizeSubscription(entry);
                if (sub.error) return [];
                return [{
                    ...sub,
                    text: normalizeText(entry.text),
                    createdAt: Number(entry.createdAt) || 0,
                    updatedAt: Number(entry.updatedAt) || 0,
                }];
            });
        } catch (err) {
            if (logger) logger.warn('[Push] subscriptions file is corrupt; starting empty', err);
            return [];
        }
    }

    function persist() {
        const tmp = `${filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, subscriptions: entries }, null, 2), { encoding: 'utf-8', mode: 0o600 });
        fs.renameSync(tmp, filePath);
    }

    function upsert(subscription, text, now = Date.now()) {
        const existing = entries.find((entry) => entry.endpoint === subscription.endpoint);
        if (existing) {
            existing.keys = subscription.keys;
            existing.text = text;
            existing.updatedAt = now;
        } else {
            entries.push({ ...subscription, text, createdAt: now, updatedAt: now });
            if (entries.length > maxEntries) {
                // Bounded: browsers that vanished without unsubscribing are
                // evicted oldest-refresh first (live ones re-sync every boot).
                entries.sort((a, b) => b.updatedAt - a.updatedAt);
                entries = entries.slice(0, maxEntries);
            }
        }
        persist();
    }

    function remove(endpoint) {
        const before = entries.length;
        entries = entries.filter((entry) => entry.endpoint !== endpoint);
        if (entries.length === before) return false;
        persist();
        return true;
    }

    return {
        upsert,
        remove,
        list: () => entries.map((entry) => ({ ...entry, keys: { ...entry.keys }, text: { ...entry.text } })),
        get size() {
            return entries.length;
        },
    };
}

// Whether (and when) a finished job should produce a push:
//   'skip' — not a reply the user is waiting on (aux side request, abort).
//   'now'  — no page is attached: nobody is watching this generation.
//   'wait' — a page was streaming or polling it; push only if that page does
//            not collect the result while visible (see shouldPushAfterClaim).
function decideJobPush(job, attachment = {}, now = Date.now()) {
    if (!job || job.kind !== 'main') return 'skip';
    if (job.status !== 'done' && job.status !== 'failed') return 'skip';
    const readers = Number(attachment.readers) || 0;
    const lastPolledAt = Number(attachment.lastPolledAt) || 0;
    if (readers > 0) return 'wait';
    if (lastPolledAt > 0 && now - lastPolledAt <= ATTACH_POLL_WINDOW_MS) return 'wait';
    return 'now';
}

// After the grace window. A claim from a VISIBLE page means the user watched
// the reply arrive; a hidden page (phone switched to another app) or no claim
// at all still gets the push. Clients that claim without the flag are older
// builds — treated as watching, the conservative choice.
function shouldPushAfterClaim(claim) {
    if (!claim) return true;
    return claim.visible === false;
}

// The recorder never parses the reply, so a provider error answer (HTTP 4xx/
// 5xx relayed in full) still finishes as 'done' — the upstream status tells.
function isFailedReply(job) {
    if (job.status === 'failed') return true;
    return Number.isFinite(job.upstreamStatus) && job.upstreamStatus >= 400;
}

function buildJobNotification({ job, label, text }) {
    const line = isFailedReply(job) ? text.failed : text.done;
    const characterName = clipText(label && label.characterName, MAX_NAME_LENGTH);
    const chatName = clipText(label && label.chatName, MAX_NAME_LENGTH);
    return {
        title: characterName || 'PocketRisu',
        body: chatName ? `${chatName} · ${line}` : line,
        // One notification per chat: a newer reply replaces the older one.
        tag: `pocketrisu-reply:${job.chatId}`,
        url: '/',
    };
}

function createPushNotifications(opts = {}) {
    const saveDir = opts.saveDir || path.join(process.cwd(), 'save');
    const logger = opts.logger || null;
    const fetchImpl = opts.fetchImpl || ((url, init) => fetch(url, init));
    const subject = opts.subject || process.env.POCKETRISU_VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT;
    const resolveChatLabel = typeof opts.resolveChatLabel === 'function' ? opts.resolveChatLabel : () => null;
    const claimGraceMs = Number.isFinite(opts.claimGraceMs) ? opts.claimGraceMs : CLAIM_GRACE_MS;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const keyPath = path.join(saveDir, VAPID_KEY_FILE);
    const store = createPushSubscriptionStore({ filePath: path.join(saveDir, SUBSCRIPTIONS_FILE), logger });

    // undefined = not loaded yet; null = unusable (unreadable key file).
    let vapidKey;

    // Created lazily on first use, so a server whose user never turns the
    // feature on writes no key file. An existing key that fails to parse is
    // never overwritten — every subscription is bound to it.
    function getVapidKey() {
        if (vapidKey !== undefined) return vapidKey;
        try {
            vapidKey = nodeCrypto.createPrivateKey(fs.readFileSync(keyPath, 'utf-8'));
            return vapidKey;
        } catch (err) {
            if (!err || err.code !== 'ENOENT') {
                if (logger) logger.error('[Push] VAPID key file is unreadable; push disabled', err);
                vapidKey = null;
                return vapidKey;
            }
        }
        const key = generateVapidPrivateKey();
        fs.writeFileSync(keyPath, key.export({ type: 'pkcs8', format: 'pem' }), { encoding: 'utf-8', mode: 0o600 });
        vapidKey = key;
        return vapidKey;
    }

    function getPublicKey() {
        const key = getVapidKey();
        return key ? base64UrlEncode(vapidPublicKeyBytes(key)) : null;
    }

    function subscribe(body) {
        const subscription = normalizeSubscription(body && body.subscription);
        if (subscription.error) return subscription;
        store.upsert(subscription, normalizeText(body.text), now());
        return { success: true };
    }

    function unsubscribe(endpoint) {
        if (typeof endpoint !== 'string' || !endpoint) return { error: 'endpoint is required' };
        return { success: true, removed: store.remove(endpoint) };
    }

    // Endpoints are capability URLs — log only their origin.
    function endpointOrigin(endpoint) {
        try { return new URL(endpoint).origin; } catch { return '<invalid>'; }
    }

    async function sendOne(subscription, payload, key) {
        const body = encryptPushPayload(Buffer.from(JSON.stringify(payload), 'utf-8'), subscription.keys);
        const res = await fetchImpl(subscription.endpoint, {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'content-encoding': 'aes128gcm',
                ttl: String(PUSH_TTL_SEC),
                // The user opted in to hear about this reply now; 'high' lets
                // the push service wake a dozing phone for it.
                urgency: 'high',
                authorization: vapidAuthorization({ endpoint: subscription.endpoint, subject, privateKey: key, now: now() }),
            },
            body,
            signal: AbortSignal.timeout(PUSH_SEND_TIMEOUT_MS),
        });
        return res.status;
    }

    // Sends to every subscription; 404/410 mean the browser dropped the
    // subscription, so the server forgets it too.
    async function sendToAll(buildPayload) {
        const subscriptions = store.list();
        if (subscriptions.length === 0) return { sent: 0, dropped: 0 };
        const key = getVapidKey();
        if (!key) return { sent: 0, dropped: 0 };
        let sent = 0;
        let dropped = 0;
        await Promise.all(subscriptions.map(async (subscription) => {
            try {
                const status = await sendOne(subscription, buildPayload(subscription), key);
                if (status >= 200 && status < 300) {
                    sent += 1;
                } else if (status === 404 || status === 410) {
                    if (store.remove(subscription.endpoint)) dropped += 1;
                    if (logger) logger.info(`[Push] subscription expired (${status}); removed`, endpointOrigin(subscription.endpoint));
                } else if (logger) {
                    logger.warn(`[Push] push service answered ${status}`, endpointOrigin(subscription.endpoint));
                }
            } catch (err) {
                if (logger) logger.warn('[Push] send failed', endpointOrigin(subscription.endpoint), String((err && err.message) || err));
            }
        }));
        return { sent, dropped };
    }

    function sendJobNotification(job) {
        let label = null;
        try {
            label = resolveChatLabel(job.chatId);
        } catch {
            label = null;
        }
        return sendToAll((subscription) => buildJobNotification({ job, label, text: subscription.text }));
    }

    // jobId → settle(claim) while a finished job waits for its page to claim.
    const pendingClaims = new Map();

    function waitForClaim(jobId) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pendingClaims.delete(jobId);
                resolve(null);
            }, claimGraceMs);
            pendingClaims.set(jobId, (claim) => {
                clearTimeout(timer);
                pendingClaims.delete(jobId);
                resolve(claim);
            });
        });
    }

    // model-jobs.cjs onJobClaimed hook.
    function noteJobClaimed(jobId, meta = {}) {
        const settle = pendingClaims.get(jobId);
        if (settle) settle({ visible: typeof meta.visible === 'boolean' ? meta.visible : undefined });
    }

    // model-jobs.cjs onJobTerminal hook. Runs synchronously up to the claim
    // registration, so a claim that follows the terminal flip is never missed.
    function handleJobTerminal(job, attachment = {}) {
        if (store.size === 0) return Promise.resolve({ sent: 0, reason: 'no-subscriptions' });
        const decision = decideJobPush(job, attachment, now());
        if (decision === 'skip') return Promise.resolve({ sent: 0, reason: 'not-a-reply' });
        if (decision === 'now') return sendJobNotification(job);
        return waitForClaim(job.id).then((claim) => (
            shouldPushAfterClaim(claim) ? sendJobNotification(job) : { sent: 0, reason: 'seen' }
        ));
    }

    // Express wiring, same auth contract as model-jobs.cjs registerRoutes.
    function registerRoutes(app, { auth }) {
        app.get('/api/push/vapid-public-key', async (req, res) => {
            if (!await auth(req, res)) return;
            let publicKey = null;
            try {
                publicKey = getPublicKey();
            } catch (err) {
                if (logger) logger.error('[Push] could not create the VAPID key', err);
            }
            if (!publicKey) {
                res.status(503).send({ error: 'Push keys are unavailable' });
                return;
            }
            res.send({ publicKey });
        });

        app.post('/api/push/subscribe', async (req, res) => {
            if (!await auth(req, res)) return;
            const result = subscribe(req.body);
            if (result.error) {
                res.status(400).send({ error: result.error });
                return;
            }
            res.send(result);
        });

        const unsubscribeRoute = async (req, res) => {
            if (!await auth(req, res)) return;
            const result = unsubscribe(req.body && req.body.endpoint);
            if (result.error) {
                res.status(400).send({ error: result.error });
                return;
            }
            res.send(result);
        };
        app.post('/api/push/unsubscribe', unsubscribeRoute);
        app.delete('/api/push/subscribe', unsubscribeRoute);
    }

    return {
        registerRoutes,
        getPublicKey,
        subscribe,
        unsubscribe,
        sendToAll,
        handleJobTerminal,
        noteJobClaimed,
        listSubscriptions: () => store.list(),
        close: () => {
            for (const settle of [...pendingClaims.values()]) settle({ visible: true });
        },
    };
}

module.exports = {
    createPushNotifications,
    createPushSubscriptionStore,
    createVapidJwt,
    vapidPublicKeyBytes,
    encryptPushPayload,
    decideJobPush,
    shouldPushAfterClaim,
    buildJobNotification,
    DEFAULT_TEXT,
    RECORD_SIZE,
};
