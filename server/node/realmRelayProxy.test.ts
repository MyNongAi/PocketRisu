import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

// The reader's relay has its own session-authenticated route. The unauthenticated
// upstream hub proxy must ignore the relay header and keep fetching the hub.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.join(HERE, 'server.cjs')
const SEARCH = '/realm/search%3D%3Dx?cache=30'
const RELAY_ROUTE = '/api/realm-relay'
const FAKE_HUB = `
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
    const url = new URL(input)
    if (url.origin === 'https://sv.risuai.xyz') {
        return Response.json({ hubPath: url.pathname + url.search })
    }
    return realFetch(input, init)
}
`

let tmpDir: string
let base: string
let child: ChildProcessWithoutNullStreams
let relay: http.Server
let relayURL: string
let relayHits: Array<{ url: string, headers: http.IncomingHttpHeaders }> = []
let cookie = ''
let output = ''

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

beforeAll(async () => {
    relay = http.createServer((req, res) => {
        relayHits.push({ url: req.url ?? '', headers: req.headers })
        if (req.url === '/sv/realm/redirect-out' || req.url === '/sv/realm/redirect-chain') {
            res.writeHead(302, { location: `${base}/api/test_auth` })
            return res.end()
        }
        if (req.url === '/sv/realm/redirect-in') {
            res.writeHead(302, { location: '/sv/realm/compressed' })
            return res.end()
        }
        if (req.url === '/sv/realm/redirect-in-out') {
            res.writeHead(302, { location: '/sv/realm/redirect-chain' })
            return res.end()
        }
        if (req.url === '/sv/realm/loop') {
            res.writeHead(302, { location: req.url })
            return res.end()
        }
        if (req.url === '/sv/realm/fetch-error') {
            return req.socket.destroy()
        }
        res.setHeader('content-type', 'application/json')
        if (req.url === '/sv/realm/compressed') {
            const compressed = gzipSync('[{"id":"relayed"}]')
            res.writeHead(206, { 'content-encoding': 'gzip', 'content-length': compressed.length, 'x-relay-result': 'kept' })
            return res.end(compressed)
        }
        res.end('[]')
    })
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
    relayURL = `http://127.0.0.1:${(relay.address() as net.AddressInfo).port}`

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realm-relay-proxy-'))
    const fakeHubPath = path.join(tmpDir, 'fake-hub.cjs')
    fs.writeFileSync(fakeHubPath, FAKE_HUB)
    const port = await reservePort()
    base = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, ['--require', fakeHubPath, SERVER_PATH], {
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
    const token = jwt(fs.readFileSync(path.join(tmpDir, 'save', '__jwt_secret'), 'utf-8').trim())
    const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'risu-auth': token } })
    expect(session.status).toBe(200)
    cookie = (session.headers.get('set-cookie') ?? '').split(';')[0]
}, 30_000)

beforeEach(() => {
    relayHits = []
})

afterAll(async () => {
    if (child && child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
        child.kill('SIGTERM')
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))])
        if (child.exitCode === null) child.kill('SIGKILL')
    }
    await new Promise<void>((resolve) => relay.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('/api/realm-relay', () => {
    it('sends a logged-in page\'s Realm search to its relay, without the cookie', async () => {
        const res = await fetch(`${base}${RELAY_ROUTE}${SEARCH}`, {
            headers: {
                cookie,
                'x-risu-realm-relay': relayURL,
                'risu-auth': 'local-token',
                'x-risuai-info': 'test;node',
                'x-risu-node-path': 'unused',
            },
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual([])
        expect(relayHits).toHaveLength(1)
        expect(relayHits[0].url).toBe(`/sv${SEARCH}`)
        expect(relayHits[0].headers.cookie).toBeUndefined()
        expect(relayHits[0].headers['x-risu-realm-relay']).toBeUndefined()
        expect(relayHits[0].headers['risu-auth']).toBeUndefined()
        expect(relayHits[0].headers['x-risu-node-path']).toBeUndefined()
        expect(relayHits[0].headers['x-risuai-info']).toBe('test;node')
        expect(relayHits[0].headers.origin).toBe('https://sv.risuai.xyz')
    })

    it('refuses to pick a relay for a request without a session', async () => {
        for (const sessionCookie of ['', 'risu-session=not-a-session']) {
            const res = await fetch(`${base}${RELAY_ROUTE}${SEARCH}`, {
                headers: { cookie: sessionCookie, 'x-risu-realm-relay': relayURL },
            })
            await res.body?.cancel()
            expect(res.status).toBe(401)
        }
        expect(relayHits).toHaveLength(0)
    })

    it('ignores the relay header on the upstream hub proxy', async () => {
        const res = await fetch(`${base}/hub-proxy${SEARCH}`, {
            headers: { cookie, 'x-risu-realm-relay': relayURL },
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ hubPath: SEARCH })
        expect(relayHits).toHaveLength(0)
    })

    it('rejects a missing or invalid relay and paths other than Realm searches', async () => {
        for (const [search, target] of [
            [SEARCH, ''],
            [SEARCH, 'file:///secret'],
            [SEARCH, 'http://user:password@relay'],
            ['/resource/secret', relayURL],
            ['/realm/%2e%2e/resource/secret', relayURL],
        ]) {
            const res = await fetch(`${base}${RELAY_ROUTE}${search}`, {
                headers: { cookie, 'x-risu-realm-relay': target },
            })
            expect(res.status).toBe(400)
            await res.body?.cancel()
        }
        expect(relayHits).toHaveLength(0)
    })

    it('follows redirects within the relay and streams decoded bodies with their status', async () => {
        const res = await fetch(`${base}${RELAY_ROUTE}/realm/redirect-in`, {
            headers: { cookie, 'x-risu-realm-relay': relayURL, 'accept-encoding': 'identity' },
            redirect: 'manual',
        })
        expect(res.status).toBe(206)
        expect(res.headers.get('content-encoding')).toBeNull()
        expect(res.headers.get('content-length')).toBeNull()
        expect(res.headers.get('location')).toBeNull()
        expect(res.headers.get('x-relay-result')).toBe('kept')
        expect(await res.json()).toEqual([{ id: 'relayed' }])
        expect(relayHits.map((hit) => hit.url)).toEqual(['/sv/realm/redirect-in', '/sv/realm/compressed'])
        expect(relayHits.every((hit) => !hit.headers.cookie && !hit.headers['x-risu-realm-relay'])).toBe(true)
    })

    it.each(['redirect-out', 'redirect-in-out'])('refuses a redirect to another origin: %s', async (search) => {
        const res = await fetch(`${base}${RELAY_ROUTE}/realm/${search}`, {
            headers: { cookie, 'x-risu-realm-relay': relayURL },
            redirect: 'manual',
        })
        expect(res.status).toBe(502)
        expect(res.headers.get('location')).toBeNull()
        expect(await res.text()).toContain('Realm relay redirected to a different origin')
        expect(relayHits).toHaveLength(search === 'redirect-out' ? 1 : 2)
    })

    it('stops a redirect loop', async () => {
        const res = await fetch(`${base}${RELAY_ROUTE}/realm/loop`, {
            headers: { cookie, 'x-risu-realm-relay': relayURL },
        })
        expect(res.status).toBe(502)
        expect(await res.text()).toContain('Too many Realm relay redirects')
    })

    it('returns 502 on a relay fetch error', async () => {
        const res = await fetch(`${base}${RELAY_ROUTE}/realm/fetch-error`, {
            headers: { cookie, 'x-risu-realm-relay': relayURL },
        })
        expect(res.status).toBe(502)
        expect(await res.text()).toContain('Realm relay request failed:')
    })
})
