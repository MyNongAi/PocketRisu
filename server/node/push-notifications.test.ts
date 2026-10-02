import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import nodeCrypto from 'node:crypto'
import pushPkg from './push-notifications.cjs'
import jobsPkg from './model-jobs.cjs'

const {
    createPushNotifications,
    createPushSubscriptionStore,
    createVapidJwt,
    vapidPublicKeyBytes,
    encryptPushPayload,
    decideJobPush,
    shouldPushAfterClaim,
    buildJobNotification,
    DEFAULT_TEXT,
} = pushPkg as any
const { createModelJobs } = jobsPkg as any

const b64u = (value: string) => Buffer.from(value.replace(/\s+/g, ''), 'base64url')

// --- RFC 8291 §5 / Appendix A -------------------------------------------------
const RFC = {
    plaintext: 'When I grow up, I want to be a watermelon',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
           mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
           pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number) {
    return Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, info, length))
}

// Receiver side of RFC 8291 (what a browser does), for round-trip checks.
function decryptPushBody(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): Buffer {
    const salt = body.subarray(0, 16)
    expect(body.readUInt32BE(16)).toBe(4096)
    const idlen = body[20]
    const asPublic = body.subarray(21, 21 + idlen)
    const ciphertext = body.subarray(21 + idlen)
    const ecdh = nodeCrypto.createECDH('prime256v1')
    ecdh.setPrivateKey(uaPrivate)
    const uaPublic = ecdh.getPublicKey()
    const ecdhSecret = ecdh.computeSecret(asPublic)
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic])
    const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32)
    const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16)
    const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12)
    const decipher = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce)
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
    const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
    let end = plain.length - 1
    while (end >= 0 && plain[end] === 0) end--
    expect(plain[end]).toBe(0x02) // last-record delimiter
    return plain.subarray(0, end)
}

// A browser-side subscription: key pair + auth secret.
function makeBrowserSubscription(endpoint = `https://push.example.test/send/${Math.random().toString(36).slice(2)}`) {
    const ecdh = nodeCrypto.createECDH('prime256v1')
    ecdh.generateKeys()
    const auth = nodeCrypto.randomBytes(16)
    return {
        privateKey: ecdh.getPrivateKey(),
        auth,
        json: {
            endpoint,
            keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
        },
    }
}

function publicKeyFromBytes(bytes: Buffer) {
    return nodeCrypto.createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: bytes.subarray(1, 33).toString('base64url'), y: bytes.subarray(33, 65).toString('base64url') },
        format: 'jwk',
    })
}

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'push-test-'))
}

describe('RFC 8291 payload encryption', () => {
    it('reproduces the RFC 8291 test vector byte for byte', () => {
        const body = encryptPushPayload(Buffer.from(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, {
            salt: b64u(RFC.salt),
            senderPrivateKey: b64u(RFC.asPrivate),
        })
        expect(body.toString('base64url')).toBe(b64u(RFC.body).toString('base64url'))
        // The header carries the sender public key from the RFC.
        expect(body.subarray(21, 86).toString('base64url')).toBe(RFC.asPublic)
    })

    it('the receiver side decrypts the RFC body (validates the test decryptor)', () => {
        const plain = decryptPushBody(b64u(RFC.body), b64u(RFC.uaPrivate), b64u(RFC.auth))
        expect(plain.toString()).toBe(RFC.plaintext)
    })

    it('round-trips with a fresh salt and ephemeral key per message', () => {
        const sub = makeBrowserSubscription()
        const a = encryptPushPayload(Buffer.from('{"title":"한글 제목"}'), sub.json.keys)
        const b = encryptPushPayload(Buffer.from('{"title":"한글 제목"}'), sub.json.keys)
        expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false)
        expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false)
        expect(decryptPushBody(a, sub.privateKey, sub.auth).toString()).toBe('{"title":"한글 제목"}')
    })

    it('rejects malformed keys and oversized payloads', () => {
        const sub = makeBrowserSubscription()
        const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url')
        expect(() => encryptPushPayload(Buffer.from('x'), { p256dh: offCurve, auth: sub.json.keys.auth })).toThrow()
        expect(() => encryptPushPayload(Buffer.from('x'), { p256dh: sub.json.keys.p256dh, auth: 'AAAA' })).toThrow(/auth/)
        expect(() => encryptPushPayload(Buffer.alloc(4096 - 16), sub.json.keys)).toThrow(/too large/)
        expect(() => encryptPushPayload(Buffer.alloc(4096 - 17), sub.json.keys)).not.toThrow()
    })
})

describe('VAPID (RFC 8292)', () => {
    it('signs an ES256 JWT for the endpoint origin that verifies with the advertised key', () => {
        const { privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        const now = Date.UTC(2026, 9, 2, 12, 0, 0)
        const jwt = createVapidJwt({ audience: 'https://fcm.googleapis.com', subject: 'mailto:a@example.com', privateKey, now })
        const [h, c, s] = jwt.split('.')
        expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
        const claims = JSON.parse(Buffer.from(c, 'base64url').toString())
        expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:a@example.com' })
        expect(claims.exp - now / 1000).toBeLessThanOrEqual(24 * 3600)
        const signature = Buffer.from(s, 'base64url')
        expect(signature.length).toBe(64) // raw r||s, not DER

        const publicBytes = vapidPublicKeyBytes(privateKey)
        expect(publicBytes.length).toBe(65)
        expect(publicBytes[0]).toBe(4)
        const ok = nodeCrypto.verify('sha256', Buffer.from(`${h}.${c}`), {
            key: publicKeyFromBytes(publicBytes),
            dsaEncoding: 'ieee-p1363',
        }, signature)
        expect(ok).toBe(true)
        const tampered = nodeCrypto.verify('sha256', Buffer.from(`${h}.${c}x`), {
            key: publicKeyFromBytes(publicBytes),
            dsaEncoding: 'ieee-p1363',
        }, signature)
        expect(tampered).toBe(false)
    })

    it('creates the key once and reuses it from save/__vapid_private_key.pem', () => {
        const dir = tempDir()
        try {
            const first = createPushNotifications({ saveDir: dir }).getPublicKey()
            expect(fs.existsSync(path.join(dir, '__vapid_private_key.pem'))).toBe(true)
            const second = createPushNotifications({ saveDir: dir }).getPublicKey()
            expect(second).toBe(first)
            expect(Buffer.from(first, 'base64url').length).toBe(65)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('never writes a key before the feature is used', () => {
        const dir = tempDir()
        try {
            createPushNotifications({ saveDir: dir })
            expect(fs.existsSync(path.join(dir, '__vapid_private_key.pem'))).toBe(false)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('push subscription store', () => {
    let dir: string
    beforeEach(() => { dir = tempDir() })
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

    it('adds, updates in place, persists and removes', () => {
        const filePath = path.join(dir, 'push-subscriptions.json')
        const store = createPushSubscriptionStore({ filePath })
        const a = makeBrowserSubscription('https://push.example.test/a')
        const b = makeBrowserSubscription('https://push.example.test/b')
        store.upsert(a.json, { done: 'D', failed: 'F' }, 1)
        store.upsert(b.json, { done: 'D', failed: 'F' }, 2)
        const a2 = makeBrowserSubscription('https://push.example.test/a')
        store.upsert(a2.json, { done: 'D2', failed: 'F2' }, 3)
        expect(store.size).toBe(2)

        const reloaded = createPushSubscriptionStore({ filePath })
        const entryA = reloaded.list().find((e: any) => e.endpoint === 'https://push.example.test/a')
        expect(entryA.keys.p256dh).toBe(a2.json.keys.p256dh)
        expect(entryA.text).toEqual({ done: 'D2', failed: 'F2' })
        expect(entryA.createdAt).toBe(1)
        expect(entryA.updatedAt).toBe(3)

        expect(reloaded.remove('https://push.example.test/a')).toBe(true)
        expect(reloaded.remove('https://push.example.test/a')).toBe(false)
        expect(createPushSubscriptionStore({ filePath }).list().map((e: any) => e.endpoint)).toEqual(['https://push.example.test/b'])
    })

    it('caps the number of subscriptions, evicting the least recently refreshed', () => {
        const store = createPushSubscriptionStore({ filePath: path.join(dir, 's.json'), maxEntries: 2 })
        store.upsert(makeBrowserSubscription('https://push.example.test/1').json, DEFAULT_TEXT, 1)
        store.upsert(makeBrowserSubscription('https://push.example.test/2').json, DEFAULT_TEXT, 2)
        store.upsert(makeBrowserSubscription('https://push.example.test/3').json, DEFAULT_TEXT, 3)
        expect(store.list().map((e: any) => e.endpoint).sort()).toEqual(['https://push.example.test/2', 'https://push.example.test/3'])
    })

    it('validates subscriptions through the notifier', () => {
        const push = createPushNotifications({ saveDir: dir })
        const good = makeBrowserSubscription()
        expect(push.subscribe({ subscription: { ...good.json, endpoint: 'http://push.example.test/x' } }).error).toMatch(/https/)
        expect(push.subscribe({ subscription: { ...good.json, keys: { ...good.json.keys, p256dh: 'AAAA' } } }).error).toBeTruthy()
        expect(push.subscribe({ subscription: { ...good.json, keys: { ...good.json.keys, auth: 'AAAA' } } }).error).toBeTruthy()
        expect(push.subscribe({}).error).toBeTruthy()
        expect(push.subscribe({ subscription: good.json, text: { done: '  ', failed: 'x'.repeat(500) } })).toEqual({ success: true })
        const [entry] = push.listSubscriptions()
        expect(entry.text.done).toBe(DEFAULT_TEXT.done)
        expect(entry.text.failed.length).toBeLessThanOrEqual(120)
        expect(push.unsubscribe('')).toEqual({ error: 'endpoint is required' })
        expect(push.unsubscribe(good.json.endpoint)).toEqual({ success: true, removed: true })
    })
})

describe('send decision on job completion', () => {
    const mainDone = { id: 'job-1', chatId: 'chat-1', kind: 'main', status: 'done', upstreamStatus: 200 }

    it('decideJobPush: skip / now / wait', () => {
        const now = 1_000_000
        expect(decideJobPush({ ...mainDone, kind: 'aux' }, {}, now)).toBe('skip')
        expect(decideJobPush({ ...mainDone, status: 'aborted' }, {}, now)).toBe('skip')
        expect(decideJobPush({ ...mainDone, status: 'running' }, {}, now)).toBe('skip')
        expect(decideJobPush(mainDone, {}, now)).toBe('now')
        expect(decideJobPush({ ...mainDone, status: 'failed' }, { readers: 0 }, now)).toBe('now')
        expect(decideJobPush(mainDone, { readers: 1 }, now)).toBe('wait')
        expect(decideJobPush(mainDone, { lastPolledAt: now - 5_000 }, now)).toBe('wait')
        expect(decideJobPush(mainDone, { lastPolledAt: now - 60_000 }, now)).toBe('now')
    })

    it('shouldPushAfterClaim: only a visible claim suppresses the push', () => {
        expect(shouldPushAfterClaim(null)).toBe(true)
        expect(shouldPushAfterClaim({ visible: false })).toBe(true)
        expect(shouldPushAfterClaim({ visible: true })).toBe(false)
        expect(shouldPushAfterClaim({ visible: undefined })).toBe(false)
    })

    it('buildJobNotification names the bot and chat, never message content', () => {
        expect(buildJobNotification({ job: mainDone, label: { characterName: 'Alice', chatName: 'Chat 1' }, text: DEFAULT_TEXT }))
            .toEqual({ title: 'Alice', body: 'Chat 1 · 답변이 도착했습니다', tag: 'pocketrisu-reply:chat-1', url: '/' })
        expect(buildJobNotification({ job: mainDone, label: null, text: DEFAULT_TEXT }))
            .toEqual({ title: 'PocketRisu', body: '답변이 도착했습니다', tag: 'pocketrisu-reply:chat-1', url: '/' })
        // A provider error relayed in full still finishes 'done' — the
        // upstream status makes it a failure notice.
        expect(buildJobNotification({ job: { ...mainDone, upstreamStatus: 429 }, label: { characterName: 'Alice' }, text: DEFAULT_TEXT }).body)
            .toBe('답변 생성에 실패했습니다')
        expect(buildJobNotification({ job: { ...mainDone, status: 'failed', upstreamStatus: null }, label: null, text: { done: 'ok', failed: 'nope' } }).body)
            .toBe('nope')
    })

    describe('handleJobTerminal with a mocked push service', () => {
        let dir: string
        let fetchMock: ReturnType<typeof vi.fn>
        let push: any
        let browser: ReturnType<typeof makeBrowserSubscription>

        beforeEach(() => {
            dir = tempDir()
            fetchMock = vi.fn(async () => new Response(null, { status: 201 }))
            push = createPushNotifications({
                saveDir: dir,
                fetchImpl: fetchMock,
                claimGraceMs: 40,
                subject: 'mailto:test@example.com',
                resolveChatLabel: (chatId: string) => (chatId === 'chat-1' ? { characterName: 'Alice', chatName: 'Chat 1' } : null),
            })
            browser = makeBrowserSubscription('https://push.example.test/endpoint-1')
            expect(push.subscribe({ subscription: browser.json, text: { done: '답변이 도착했습니다', failed: '실패' } })).toEqual({ success: true })
        })
        afterEach(() => {
            push.close()
            fs.rmSync(dir, { recursive: true, force: true })
        })

        it('sends an encrypted, VAPID-signed push to the subscription endpoint', async () => {
            await expect(push.handleJobTerminal(mainDone, {})).resolves.toMatchObject({ sent: 1 })
            expect(fetchMock).toHaveBeenCalledTimes(1)
            const [url, init] = fetchMock.mock.calls[0] as [string, any]
            expect(url).toBe('https://push.example.test/endpoint-1')
            expect(init.method).toBe('POST')
            expect(init.headers['content-encoding']).toBe('aes128gcm')
            expect(init.headers['content-type']).toBe('application/octet-stream')
            expect(init.headers.ttl).toBe(String(12 * 3600))
            expect(init.headers.urgency).toBe('high')

            const auth = /^vapid t=([^,]+), k=(.+)$/.exec(init.headers.authorization)!
            expect(auth).toBeTruthy()
            expect(auth[2]).toBe(push.getPublicKey())
            const [h, c, s] = auth[1].split('.')
            expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toMatchObject({ aud: 'https://push.example.test', sub: 'mailto:test@example.com' })
            expect(nodeCrypto.verify('sha256', Buffer.from(`${h}.${c}`), {
                key: publicKeyFromBytes(Buffer.from(auth[2], 'base64url')),
                dsaEncoding: 'ieee-p1363',
            }, Buffer.from(s, 'base64url'))).toBe(true)

            const payload = JSON.parse(decryptPushBody(Buffer.from(init.body), browser.privateKey, browser.auth).toString())
            expect(payload).toEqual({ title: 'Alice', body: 'Chat 1 · 답변이 도착했습니다', tag: 'pocketrisu-reply:chat-1', url: '/' })
        })

        it('skips aux and aborted jobs and sends nothing without subscriptions', async () => {
            await push.handleJobTerminal({ ...mainDone, kind: 'aux' }, {})
            await push.handleJobTerminal({ ...mainDone, status: 'aborted' }, {})
            expect(fetchMock).not.toHaveBeenCalled()
            push.unsubscribe(browser.json.endpoint)
            await expect(push.handleJobTerminal(mainDone, {})).resolves.toMatchObject({ sent: 0, reason: 'no-subscriptions' })
            expect(fetchMock).not.toHaveBeenCalled()
        })

        it('an attached page that claims while visible suppresses the push', async () => {
            const pending = push.handleJobTerminal(mainDone, { readers: 1 })
            push.noteJobClaimed('job-1', { visible: true })
            await expect(pending).resolves.toMatchObject({ sent: 0, reason: 'seen' })
            expect(fetchMock).not.toHaveBeenCalled()
        })

        it('a claim from a hidden page still pushes, right away', async () => {
            const pending = push.handleJobTerminal(mainDone, { readers: 1 })
            push.noteJobClaimed('job-1', { visible: false })
            await expect(pending).resolves.toMatchObject({ sent: 1 })
        })

        it('an attached page that never claims gets the push after the grace window', async () => {
            const started = Date.now()
            await expect(push.handleJobTerminal(mainDone, { lastPolledAt: Date.now() })).resolves.toMatchObject({ sent: 1 })
            expect(Date.now() - started).toBeGreaterThanOrEqual(30)
        })

        it('drops subscriptions the push service answers with 404/410 and keeps them on other errors', async () => {
            const gone = makeBrowserSubscription('https://push.example.test/gone')
            const missing = makeBrowserSubscription('https://push.example.test/missing')
            const flaky = makeBrowserSubscription('https://push.example.test/flaky')
            for (const sub of [gone, missing, flaky]) push.subscribe({ subscription: sub.json })
            fetchMock.mockImplementation(async (url: string) => {
                if (url.endsWith('/gone')) return new Response(null, { status: 410 })
                if (url.endsWith('/missing')) return new Response(null, { status: 404 })
                if (url.endsWith('/flaky')) return new Response(null, { status: 500 })
                return new Response(null, { status: 201 })
            })
            await expect(push.handleJobTerminal(mainDone, {})).resolves.toMatchObject({ sent: 1, dropped: 2 })
            const endpoints = push.listSubscriptions().map((e: any) => e.endpoint).sort()
            expect(endpoints).toEqual(['https://push.example.test/endpoint-1', 'https://push.example.test/flaky'])
            // Persisted: a restarted server does not retry the dead endpoints.
            const reloaded = createPushNotifications({ saveDir: dir }).listSubscriptions().map((e: any) => e.endpoint).sort()
            expect(reloaded).toEqual(endpoints)
        })

        it('a network failure to one endpoint does not stop the others', async () => {
            push.subscribe({ subscription: makeBrowserSubscription('https://push.example.test/down').json })
            fetchMock.mockImplementation(async (url: string) => {
                if (url.endsWith('/down')) throw new TypeError('fetch failed')
                return new Response(null, { status: 201 })
            })
            await expect(push.handleJobTerminal(mainDone, {})).resolves.toMatchObject({ sent: 1 })
            expect(push.listSubscriptions()).toHaveLength(2)
        })
    })
})

// --- HTTP wiring: model-jobs hooks + /api/push routes ------------------------

const AUTH_TOKEN = 'test-token'
async function stubAuth(req: any, res: any) {
    if (req.headers['risu-auth'] === AUTH_TOKEN) return true
    res.status(400).send({ error: 'No auth header' })
    return false
}

function listen(server: http.Server): Promise<number> {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port))
    })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('server reply push over HTTP', () => {
    let saveDir: string
    let jobs: any
    let push: any
    let fetchMock: ReturnType<typeof vi.fn>
    let appServer: http.Server
    let upstreamServer: http.Server
    let base: string
    let upstreamUrl: string
    let browser: ReturnType<typeof makeBrowserSubscription>
    const headers = { 'risu-auth': AUTH_TOKEN, 'content-type': 'application/json' }

    beforeAll(async () => {
        saveDir = tempDir()
        fetchMock = vi.fn(async () => new Response(null, { status: 201 }))
        push = createPushNotifications({
            saveDir,
            fetchImpl: fetchMock,
            claimGraceMs: 400,
            resolveChatLabel: () => ({ characterName: 'Alice', chatName: 'Chat 1' }),
        })
        jobs = createModelJobs({
            saveDir,
            onJobTerminal: (job: any, attachment: any) => push.handleJobTerminal(job, attachment),
            onJobClaimed: (jobId: string, meta: any) => push.noteJobClaimed(jobId, meta),
        })
        const app = express()
        app.use(express.json())
        jobs.registerRoutes(app, { auth: stubAuth })
        push.registerRoutes(app, { auth: stubAuth })
        appServer = http.createServer(app)
        base = `http://127.0.0.1:${await listen(appServer)}`

        upstreamServer = http.createServer((req, res) => {
            req.resume()
            req.on('end', async () => {
                res.writeHead(200, { 'content-type': 'text/event-stream' })
                for (const chunk of ['data: a\n\n', 'data: b\n\n']) {
                    res.write(chunk)
                    await sleep(80)
                }
                res.end()
            })
        })
        upstreamUrl = `http://127.0.0.1:${await listen(upstreamServer)}`
    })

    afterAll(() => {
        push.close()
        jobs.close()
        upstreamServer.close()
        appServer.close()
        fs.rmSync(saveDir, { recursive: true, force: true })
    })

    beforeEach(() => {
        fetchMock.mockClear()
    })

    async function createJob() {
        const res = await fetch(`${base}/api/model-jobs`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                targetUrl: upstreamUrl,
                body: '{}',
                chatId: `chat-${Math.random().toString(36).slice(2)}`,
                generationId: 'gen-1',
                streaming: true,
            }),
        })
        expect(res.status).toBe(200)
        return (await res.json()).jobId as string
    }

    it('routes require auth', async () => {
        expect((await fetch(`${base}/api/push/vapid-public-key`)).status).toBe(400)
        expect((await fetch(`${base}/api/push/subscribe`, { method: 'POST' })).status).toBe(400)
        expect((await fetch(`${base}/api/push/unsubscribe`, { method: 'POST' })).status).toBe(400)
    })

    it('serves the VAPID key and stores a subscription', async () => {
        const keyRes = await fetch(`${base}/api/push/vapid-public-key`, { headers })
        const { publicKey } = await keyRes.json()
        expect(Buffer.from(publicKey, 'base64url').length).toBe(65)

        const bad = await fetch(`${base}/api/push/subscribe`, { method: 'POST', headers, body: JSON.stringify({ subscription: { endpoint: 'nope' } }) })
        expect(bad.status).toBe(400)

        browser = makeBrowserSubscription('https://push.example.test/http-endpoint')
        const ok = await fetch(`${base}/api/push/subscribe`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ subscription: browser.json, text: { done: '답변이 도착했습니다', failed: '답변 생성에 실패했습니다' } }),
        })
        expect(await ok.json()).toEqual({ success: true })
        expect(JSON.parse(fs.readFileSync(path.join(saveDir, 'push-subscriptions.json'), 'utf-8')).subscriptions).toHaveLength(1)
    })

    it('a job that finishes with no page attached pushes once', async () => {
        await createJob()
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 5000 })
        const [url, init] = fetchMock.mock.calls[0] as [string, any]
        expect(url).toBe('https://push.example.test/http-endpoint')
        const payload = JSON.parse(decryptPushBody(Buffer.from(init.body), browser.privateKey, browser.auth).toString())
        expect(payload.title).toBe('Alice')
        expect(payload.body).toBe('Chat 1 · 답변이 도착했습니다')
        expect(JSON.stringify(payload)).not.toContain('data: a')
    })

    it('a page that streams the job and claims it while visible gets no push', async () => {
        const jobId = await createJob()
        const stream = await fetch(`${base}/api/model-jobs/${jobId}/stream`, { headers: { 'risu-auth': AUTH_TOKEN } })
        expect(await stream.text()).toBe('data: a\n\ndata: b\n\n')
        const claim = await fetch(`${base}/api/model-jobs/${jobId}/claim`, { method: 'POST', headers, body: JSON.stringify({ visible: true }) })
        expect(claim.status).toBe(200)
        await sleep(600) // past the 400 ms grace window
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('a page that finishes the stream in the background still gets the push', async () => {
        const jobId = await createJob()
        const stream = await fetch(`${base}/api/model-jobs/${jobId}/stream`, { headers: { 'risu-auth': AUTH_TOKEN } })
        await stream.text()
        await fetch(`${base}/api/model-jobs/${jobId}/claim`, { method: 'POST', headers, body: JSON.stringify({ visible: false }) })
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 2000 })
    })

    it('unsubscribe (POST and DELETE) removes the subscription', async () => {
        const res = await fetch(`${base}/api/push/unsubscribe`, { method: 'POST', headers, body: JSON.stringify({ endpoint: browser.json.endpoint }) })
        expect(await res.json()).toEqual({ success: true, removed: true })
        const again = await fetch(`${base}/api/push/subscribe`, { method: 'DELETE', headers, body: JSON.stringify({ endpoint: browser.json.endpoint }) })
        expect(await again.json()).toEqual({ success: true, removed: false })
        await createJob()
        await sleep(600)
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
