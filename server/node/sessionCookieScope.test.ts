import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// A browser keeps cookies per host, not per port. Two PocketRisu servers on
// one host (localhost:6001 and localhost:6014, or one tailnet name on :443
// and :8443) both answered /api/session with a cookie named `risu-session`,
// so logging in to one replaced the other's. That tab's <img> requests, which
// only carry the cookie, then all got 401 and showed "External asset
// unavailable" until a reload asked for a new cookie (2026-11-06, seen right
// after a module import in a test instance).

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.join(HERE, 'server.cjs')
// Behind the session cookie check: 401 without a valid cookie, 400 (not an
// external URI) once the cookie passes.
const COOKIE_PROBE = '/api/external-assets/content/00'

type Instance = {
    dir: string
    base: string
    child: ChildProcessWithoutNullStreams
    token: string
    output: string
}

let instances: Instance[] = []

function jwt(secret: string) {
    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300 })).toString('base64url')
    const sig = crypto.createHmac('sha256', secret)
        .update(`${header}.${payload}`)
        .digest('base64url')
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

async function startInstance(): Promise<Instance> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cookie-scope-'))
    const port = await reservePort()
    const base = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, [SERVER_PATH], {
        cwd: dir,
        env: {
            ...process.env,
            PORT: String(port),
            RISU_TUNNEL_DISABLED: 'true',
            RISU_UPDATE_CHECK: 'false',
            POCKETRISU_BACKUP_INTERVAL_MS: String(60 * 60 * 1000),
        },
    })
    const instance: Instance = { dir, base, child, token: '', output: '' }
    child.stdout.on('data', (chunk) => { instance.output += String(chunk) })
    child.stderr.on('data', (chunk) => { instance.output += String(chunk) })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited early\n${instance.output}`)
        try {
            if ((await fetch(`${base}/api/test_auth`)).ok) break
        } catch {
            // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const secret = fs.readFileSync(path.join(dir, 'save', '__jwt_secret'), 'utf-8').trim()
    instance.token = jwt(secret)
    return instance
}

async function stopInstance(instance: Instance) {
    const { child } = instance
    if (child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
        child.kill('SIGTERM')
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))])
        if (child.exitCode === null) child.kill('SIGKILL')
    }
    fs.rmSync(instance.dir, { recursive: true, force: true })
}

/** What the page's boot does (NodeStorage.initSession); returns name=value. */
async function login(instance: Instance) {
    const res = await fetch(`${instance.base}/api/session`, {
        method: 'POST',
        headers: { 'risu-auth': instance.token },
    })
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    return cookie.split(';')[0]
}

/** A browser's cookie store for one host: a cookie of the same name replaces the old one, whatever the port. */
class HostCookieJar {
    private cookies = new Map<string, string>()
    store(pair: string) {
        const eq = pair.indexOf('=')
        this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
    header() {
        return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    }
}

async function probe(instance: Instance, cookie: string) {
    const res = await fetch(`${instance.base}${COOKIE_PROBE}`, { headers: { cookie } })
    await res.body?.cancel()
    return res.status
}

beforeEach(async () => {
    instances = await Promise.all([startInstance(), startInstance()])
}, 40_000)

afterEach(async () => {
    await Promise.all(instances.map(stopInstance))
    instances = []
})

describe('session cookie scope', () => {
    it('keeps a tab\'s media cookie when another server on the same host logs in', async () => {
        const [first, second] = instances
        const jar = new HostCookieJar()

        jar.store(await login(first))
        expect(await probe(first, jar.header())).toBe(400)

        jar.store(await login(second))
        expect(await probe(second, jar.header())).toBe(400)
        expect(await probe(first, jar.header())).toBe(400)
    }, 40_000)

    it('still accepts the cookie name a tab got before servers named it', async () => {
        const [first, second] = instances
        const own = await login(first)
        const token = own.slice(own.indexOf('=') + 1)

        expect(await probe(first, `risu-session=${token}`)).toBe(400)
        // Another server's cookie under the old name does not get in the way.
        const other = await login(second)
        expect(await probe(first, `risu-session=${other.slice(other.indexOf('=') + 1)}; ${own}`)).toBe(400)
        expect(await probe(first, 'risu-session=not-a-session')).toBe(401)
    }, 40_000)
})
