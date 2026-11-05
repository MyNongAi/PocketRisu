import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The Realm relay (realmRelay.cjs) through the real /hub-proxy. Upstream's
// fix keeps that route on the hub origin because it takes no auth; a Realm
// search naming the reader's relay is the one request allowed elsewhere, so
// it needs the page's session cookie, and the cookie still stays here.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.join(HERE, 'server.cjs')
const SEARCH = '/realm/search%3D%3Dx?cache=30'

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
        res.setHeader('content-type', 'application/json')
        res.end('[]')
    })
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
    relayURL = `http://127.0.0.1:${(relay.address() as net.AddressInfo).port}`

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realm-relay-proxy-'))
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

describe('/hub-proxy Realm relay', () => {
    it('sends a logged-in page\'s Realm search to its relay, without the cookie', async () => {
        const res = await fetch(`${base}/hub-proxy${SEARCH}`, {
            headers: { cookie, 'x-risu-realm-relay': relayURL },
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual([])
        expect(relayHits).toHaveLength(1)
        expect(relayHits[0].url).toBe(`/sv${SEARCH}`)
        expect(relayHits[0].headers.cookie).toBeUndefined()
        expect(relayHits[0].headers['x-risu-realm-relay']).toBeUndefined()
    })

    it('refuses to pick a relay for a request without a session', async () => {
        for (const sessionCookie of ['', 'risu-session=not-a-session']) {
            const res = await fetch(`${base}/hub-proxy${SEARCH}`, {
                headers: { cookie: sessionCookie, 'x-risu-realm-relay': relayURL },
            })
            await res.body?.cancel()
            expect(res.status).toBe(401)
        }
        expect(relayHits).toHaveLength(0)
    })
})
