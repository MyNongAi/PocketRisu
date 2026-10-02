import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { Packr } from 'msgpackr'

// End to end: a cancelled import's rollback through the real server, with the
// default filesystem external asset store and internal assets/* rows.

const packr = new Packr({ useRecords: false })
const magicHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])

function encodeRisuSaveLegacy(data: Record<string, unknown>) {
    const encoded = packr.encode(data)
    const result = new Uint8Array(encoded.length + magicHeader.length)
    result.set(magicHeader, 0)
    result.set(encoded, magicHeader.length)
    return result
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.join(HERE, 'server.cjs')
const IMPORT_ID = '0f0e0d0c-0b0a-4908-8706-050403020100'

let tmpDir: string
let base: string
let child: ChildProcessWithoutNullStreams
let token: string
let stdout = ''
let stderr = ''

const hexKey = (key: string) => Buffer.from(key, 'utf-8').toString('hex')
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
const externalUri = (value: string) => `external://local/${sha256(value)}`
const externalFile = (value: string) => {
    const hash = sha256(value)
    return path.join(tmpDir, 'save', 'external-assets', 'store', hash.slice(0, 2), hash)
}

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

async function waitForServer() {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited early\nstdout:\n${stdout}\nstderr:\n${stderr}`)
        try {
            if ((await fetch(`${base}/api/test_auth`)).ok) return
        } catch {
            // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`server did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`)
}

async function stopServer() {
    if (!child || child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))])
    if (child.exitCode === null) child.kill('SIGKILL')
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'risu-auth': token, 'x-session-id': 'import-rollback-test-session', ...extra }
}

async function writeInternal(key: string, value: string | Uint8Array, importId?: string) {
    return fetch(`${base}/api/write`, {
        method: 'POST',
        headers: headers({
            'file-path': hexKey(key),
            'content-type': 'application/octet-stream',
            ...(importId ? { 'x-import-id': importId } : {}),
        }),
        body: Buffer.from(value) as any,
    })
}

async function writeExternal(value: string, importId?: string) {
    const res = await fetch(`${base}/api/external-assets/write`, {
        method: 'POST',
        headers: headers({
            'file-path': hexKey(`assets/${sha256(value)}.png`),
            'content-type': 'application/octet-stream',
            ...(importId ? { 'x-import-id': importId } : {}),
        }),
        body: Buffer.from(value) as any,
    })
    return res
}

async function post(route: string, body: unknown) {
    return fetch(`${base}${route}`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
    })
}

function hasKv(key: string) {
    const db = new Database(path.join(tmpDir, 'save', 'risuai.db'))
    db.pragma('busy_timeout = 5000')
    try {
        return Boolean(db.prepare('SELECT 1 AS ok FROM kv WHERE key = ?').get(key))
    } finally {
        db.close()
    }
}

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-rollback-test-'))
    const port = await reservePort()
    base = `http://127.0.0.1:${port}`
    stdout = ''
    stderr = ''
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
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    await waitForServer()
    const secret = fs.readFileSync(path.join(tmpDir, 'save', '__jwt_secret'), 'utf-8').trim()
    token = jwt(secret)
})

afterEach(async () => {
    await stopServer()
    fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('/api/import-journal/rollback', () => {
    it('deletes only what the cancelled import created and nothing else uses', async () => {
        // A bot that already uses one external image and one internal asset,
        // and one that references content the import will write later.
        expect((await writeExternal('shared portrait')).status).toBe(200)
        expect((await writeInternal('assets/live.png', 'live')).status).toBe(200)
        expect((await writeInternal('database/database.bin', encodeRisuSaveLegacy({
            characters: [
                { chaId: 'keep', image: externalUri('shared portrait'), emotionImages: [['smile', 'assets/live.png']], chats: [] },
                { chaId: 'refers', image: externalUri('referenced later'), chats: [] },
            ],
        }))).status).toBe(200)

        expect((await post('/api/import-journal/begin', { id: IMPORT_ID })).status).toBe(200)
        for (const value of ['shared portrait', 'only in the cancelled card', 'touched by another save', 'referenced later']) {
            expect((await writeExternal(value, IMPORT_ID)).status).toBe(200)
        }
        expect((await writeInternal('assets/fresh.png', 'fresh', IMPORT_ID)).status).toBe(200)
        expect((await writeInternal('assets/live.png', 'live', IMPORT_ID)).status).toBe(200)
        // An untagged save wrote the same bytes as one of the import's new objects.
        expect((await writeExternal('touched by another save')).status).toBe(200)

        const res = await post('/api/import-journal/rollback', { id: IMPORT_ID })
        expect(res.status, `${stdout}\n${stderr}`).toBe(200)
        const body = await res.json()
        expect(body).toMatchObject({ ok: true, removed: 2, kept: 4, reused: 2, reasons: { shared: 1, referenced: 1 } })

        expect(fs.existsSync(externalFile('only in the cancelled card'))).toBe(false)
        expect(hasKv('assets/fresh.png')).toBe(false)
        expect(fs.existsSync(externalFile('shared portrait'))).toBe(true)
        expect(fs.existsSync(externalFile('touched by another save'))).toBe(true)
        expect(fs.existsSync(externalFile('referenced later'))).toBe(true)
        expect(hasKv('assets/live.png')).toBe(true)

        // A write that arrives after the rollback is refused, not orphaned.
        expect((await writeExternal('late write', IMPORT_ID)).status).toBe(409)
        expect((await writeInternal('assets/late.png', 'late', IMPORT_ID)).status).toBe(409)
        // The same bytes can be imported again by anyone.
        expect((await writeExternal('only in the cancelled card')).status).toBe(200)
        expect(fs.existsSync(externalFile('only in the cancelled card'))).toBe(true)
    }, 30_000)

    it('deletes nothing for a journal it does not know', async () => {
        expect((await writeInternal('assets/stray.png', 'stray', IMPORT_ID)).status).toBe(200)
        const res = await post('/api/import-journal/rollback', { id: IMPORT_ID })
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ removed: 0, unknown: true })
        expect(hasKv('assets/stray.png')).toBe(true)
        expect((await post('/api/import-journal/rollback', { id: '../x' })).status).toBe(400)
    }, 30_000)

    it('a committed import keeps everything and refuses further tagged writes', async () => {
        expect((await post('/api/import-journal/begin', { id: IMPORT_ID })).status).toBe(200)
        expect((await writeExternal('kept card art', IMPORT_ID)).status).toBe(200)
        expect((await post('/api/import-journal/commit', { id: IMPORT_ID })).status).toBe(200)
        const res = await post('/api/import-journal/rollback', { id: IMPORT_ID })
        expect(await res.json()).toMatchObject({ removed: 0 })
        expect(fs.existsSync(externalFile('kept card art'))).toBe(true)
        expect((await post('/api/import-journal/begin', { id: IMPORT_ID })).status).toBe(409)
    }, 30_000)
})
