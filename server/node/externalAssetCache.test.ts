import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// A stored picture's URL names the SHA-256 of its bytes, so the browser may
// keep them. The content route answered `private, no-store`, and a card
// battle that redraws its window every scene downloaded every picture again
// each time (over 1,200 requests in a few turns, pictures blank mid-scene;
// 2026-11-06). Now the hash is a strong ETag and `private, no-cache` makes the
// browser ask before reusing a copy: a 304 with no body, behind the same
// session cookie check as before.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.join(HERE, 'server.cjs')

let tmpDir: string
let base: string
let child: ChildProcessWithoutNullStreams
let token: string
let cookie: string
let output = ''

const hexKey = (key: string) => Buffer.from(key, 'utf-8').toString('hex')
const sha256 = (value: Uint8Array) => crypto.createHash('sha256').update(value).digest('hex')
const contentUrl = (uri: string) => `${base}/api/external-assets/content/${hexKey(uri)}`

// Signatures only; the server serves bytes, it does not decode them.
const WEBP = Buffer.concat([
    Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 '),
    crypto.randomBytes(18),
])
const AVIF = Buffer.concat([
    Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), crypto.randomBytes(20),
])
const MP3 = Buffer.concat([Buffer.from('ID3'), crypto.randomBytes(29)])

function jwt(secret: string) {
    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300 })).toString('base64url')
    const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
    return `${header}.${payload}.${sig}`
}

function reservePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const nextPort = (server.address() as net.AddressInfo).port
            server.close(() => resolve(nextPort))
        })
    })
}

/** An asset import as nodeStorage does it: Risu names the file .png whatever it holds. */
async function writeExternal(key: string, data: Buffer) {
    const res = await fetch(`${base}/api/external-assets/write`, {
        method: 'POST',
        headers: {
            'risu-auth': token,
            'file-path': hexKey(key),
            'content-type': 'application/octet-stream',
        },
        body: data,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hash).toBe(sha256(data))
    return body.uri as string
}

/**
 * A GET with exactly these headers, as a browser revalidating its own cached
 * copy sends it. fetch() cannot stand in: a conditional request makes it add
 * Cache-Control: no-cache (the Fetch standard), which asks for the bytes.
 */
function get(url: string, headers: Record<string, string> = {}): Promise<{ res: { status: number, headers: Headers }, body: Buffer }> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { headers: { cookie, ...headers } }, (incoming) => {
            const chunks: Buffer[] = []
            incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
            incoming.on('end', () => {
                const responseHeaders = new Headers()
                for (const [name, value] of Object.entries(incoming.headers)) {
                    if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value)
                }
                resolve({ res: { status: incoming.statusCode ?? 0, headers: responseHeaders }, body: Buffer.concat(chunks) })
            })
            incoming.on('error', reject)
        })
        req.on('error', reject)
    })
}

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-asset-cache-'))
    const port = await reservePort()
    base = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, [SERVER_PATH], {
        cwd: tmpDir,
        env: {
            ...process.env,
            PORT: String(port),
            RISU_TUNNEL_DISABLED: 'true',
            RISU_UPDATE_CHECK: 'false',
            POCKETRISU_BACKUP_INTERVAL_MS: String(60 * 60 * 1000),
        },
    })
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited early\n${output}`)
        try {
            if ((await fetch(`${base}/api/test_auth`)).ok) break
        } catch {
            // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    token = jwt(fs.readFileSync(path.join(tmpDir, 'save', '__jwt_secret'), 'utf-8').trim())
    const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'risu-auth': token } })
    expect(session.status).toBe(200)
    cookie = (session.headers.get('set-cookie') ?? '').split(';')[0]
}, 30_000)

afterAll(async () => {
    if (child && child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
        child.kill('SIGTERM')
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))])
        if (child.exitCode === null) child.kill('SIGKILL')
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('external asset content caching', () => {
    it('lets the browser keep the bytes and revalidate them by their hash', async () => {
        const uri = await writeExternal('assets/cache-webp.png', WEBP)
        const { res, body } = await get(contentUrl(uri))

        expect(res.status).toBe(200)
        expect(body.equals(WEBP)).toBe(true)
        expect(res.headers.get('cache-control')).toBe('private, no-cache')
        // Strong: the bytes behind a hash never change.
        expect(res.headers.get('etag')).toBe(`"${sha256(WEBP)}"`)
    }, 20_000)

    it('answers a matching If-None-Match with an empty 304', async () => {
        const uri = await writeExternal('assets/cache-304.png', WEBP)
        const etag = `"${sha256(WEBP)}"`

        for (const ifNoneMatch of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
            const { res, body } = await get(contentUrl(uri), { 'if-none-match': ifNoneMatch })
            expect(res.status, ifNoneMatch).toBe(304)
            expect(body.length).toBe(0)
            expect(res.headers.get('etag')).toBe(etag)
            expect(res.headers.get('cache-control')).toBe('private, no-cache')
        }

        const stale = await get(contentUrl(uri), { 'if-none-match': '"0000"' })
        expect(stale.res.status).toBe(200)
        expect(stale.body.equals(WEBP)).toBe(true)
    }, 20_000)

    it('sends the bytes when the request itself asks for no cache', async () => {
        // nodeStorage.readExternalAsset (exports, verification) sends this.
        const uri = await writeExternal('assets/cache-reload.png', WEBP)
        const { res, body } = await get(contentUrl(uri), {
            'if-none-match': `"${sha256(WEBP)}"`,
            'cache-control': 'no-cache',
        })
        expect(res.status).toBe(200)
        expect(body.equals(WEBP)).toBe(true)
    }, 20_000)

    it('checks the session before confirming a cached copy', async () => {
        const uri = await writeExternal('assets/cache-auth.png', WEBP)
        const etag = `"${sha256(WEBP)}"`

        for (const sessionCookie of ['', 'risu-session=expired-or-revoked']) {
            const { res } = await get(contentUrl(uri), { cookie: sessionCookie, 'if-none-match': etag })
            expect(res.status).toBe(401)
            expect(res.headers.get('etag')).toBeNull()
        }
    }, 20_000)

    it('does not confirm a hash the manifest no longer has', async () => {
        const missing = `external://local/${sha256(Buffer.from('never written'))}`
        const { res } = await get(contentUrl(missing), { 'if-none-match': `"${sha256(Buffer.from('never written'))}"` })
        expect(res.status).toBe(404)
        expect(res.headers.get('etag')).not.toBe(`"${sha256(Buffer.from('never written'))}"`)
    }, 20_000)

    it('serves each stored asset as what its bytes are, not as its .png name', async () => {
        const webp = await get(contentUrl(await writeExternal('assets/kind-webp.png', WEBP)))
        expect(webp.res.headers.get('content-type')).toBe('image/webp')

        const avif = await get(contentUrl(await writeExternal('assets/kind-avif.png', AVIF)))
        expect(avif.res.headers.get('content-type')).toBe('image/avif')

        // No signature the server knows: the stored type (from the name) stays.
        const mp3 = await get(contentUrl(await writeExternal('assets/kind-audio.mp3', MP3)))
        expect(mp3.res.headers.get('content-type')).toBe('audio/mpeg')
    }, 20_000)

    it('serves an internal asset named .png as what its bytes are', async () => {
        const key = 'assets/internal-webp.png'
        const write = await fetch(`${base}/api/write`, {
            method: 'POST',
            headers: {
                'risu-auth': token,
                'file-path': hexKey(key),
                'content-type': 'application/octet-stream',
            },
            body: WEBP,
        })
        expect(write.status).toBe(200)
        const { res, body } = await get(`${base}/api/asset/${hexKey(key)}`)
        expect(res.status).toBe(200)
        expect(body.equals(WEBP)).toBe(true)
        expect(res.headers.get('content-type')).toBe('image/webp')
    }, 20_000)
})
