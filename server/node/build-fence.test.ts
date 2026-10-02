import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
    BUILD_ID_HEADER,
    STALE_BUILD_CODE,
    parseBuildId,
    isMutatingRequest,
    staleBuildFor,
    createBuildIdReader,
    createBuildFence,
} = require('./build-fence.cjs')
const express = require('express')

let dir: string
let file: string

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-fence-'))
    file = path.join(dir, 'build-id.txt')
})

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

describe('build fence decision', () => {
    const write = { method: 'POST', path: '/api/patch' }

    it('lets a request without the header through', () => {
        expect(staleBuildFor({ ...write, clientBuild: undefined, serverBuild: 'b2' })).toBeNull()
        expect(staleBuildFor({ ...write, clientBuild: '', serverBuild: 'b2' })).toBeNull()
    })

    it('lets a matching build through', () => {
        expect(staleBuildFor({ ...write, clientBuild: 'b2', serverBuild: 'b2' })).toBeNull()
    })

    it('refuses a different build with the server build id', () => {
        expect(staleBuildFor({ ...write, clientBuild: 'b1', serverBuild: 'b2' })).toBe('b2')
    })

    it('fails open while the server build id is unknown', () => {
        expect(staleBuildFor({ ...write, clientBuild: 'b1', serverBuild: null })).toBeNull()
    })

    it('never refuses a read', () => {
        expect(staleBuildFor({ method: 'GET', path: '/api/read', clientBuild: 'b1', serverBuild: 'b2' })).toBeNull()
        expect(staleBuildFor({ method: 'POST', path: '/api/db/boot', clientBuild: 'b1', serverBuild: 'b2' })).toBeNull()
    })
})

describe('mutating request classification', () => {
    it.each([
        ['POST', '/api/write'],
        ['POST', '/api/patch'],
        ['POST', '/API/PATCH/'],
        ['POST', '/api/chat-content/c1/0'],
        ['POST', '/api/assets/bulk-write'],
        ['POST', '/api/external-assets/write'],
        ['POST', '/api/session/claim'],
        ['POST', '/api/chat-session/c1/chat1/claim'],
        ['DELETE', '/api/chat-session/c1/chat1'],
        ['PUT', '/api/external-assets/config'],
        ['PATCH', '/api/asset-manifests/owner/module/m1'],
        ['POST', '/api/characters/c1/archive'],
        ['GET', '/api/remove'],
        ['HEAD', '/api/remove'],
    ])('%s %s may change state', (method, requestPath) => {
        expect(isMutatingRequest(method, requestPath)).toBe(true)
    })

    it.each([
        ['GET', '/api/read'],
        ['GET', '/api/chat-content/c1/0'],
        ['GET', '/api/sync/events'],
        ['POST', '/api/db/boot'],
        ['POST', '/api/assets/bulk-read'],
        ['POST', '/api/asset-manifests/resolve'],
        ['POST', '/api/session'],
        ['POST', '/api/db/flush'],
        ['OPTIONS', '/api/write'],
        ['POST', '/proxy2'],
        ['GET', '/'],
    ])('%s %s does not', (method, requestPath) => {
        expect(isMutatingRequest(method, requestPath)).toBe(false)
    })
})

describe('build id file', () => {
    it('accepts one trimmed token and nothing else', () => {
        expect(parseBuildId('abc123def456-lx9k2\n')).toBe('abc123def456-lx9k2')
        expect(parseBuildId('')).toBeNull()
        expect(parseBuildId('two words')).toBeNull()
        expect(parseBuildId('x'.repeat(129))).toBeNull()
        expect(parseBuildId(undefined)).toBeNull()
    })

    it('is unknown while missing and follows rewrites', () => {
        const read = createBuildIdReader({ file })
        expect(read()).toBeNull()
        fs.writeFileSync(file, 'b1\n')
        expect(read()).toBe('b1')
        fs.writeFileSync(file, 'build-two\n')
        expect(read()).toBe('build-two')
        fs.writeFileSync(file, 'not a build id\n')
        expect(read()).toBeNull()
        fs.rmSync(file)
        expect(read()).toBeNull()
    })

    it('reads the file again only when it changed', () => {
        fs.writeFileSync(file, 'b1\n')
        const readFileSync = vi.fn(fs.readFileSync)
        const read = createBuildIdReader({ file, fsImpl: { statSync: fs.statSync, readFileSync } })
        expect(read()).toBe('b1')
        expect(read()).toBe('b1')
        expect(readFileSync).toHaveBeenCalledTimes(1)
    })
})

describe('build fence middleware over HTTP', () => {
    async function serve() {
        const app = express()
        let parsedBodies = 0
        let writes = 0
        const logger = { warn: vi.fn() }
        app.use(createBuildFence({ readBuildId: createBuildIdReader({ file }), logger }))
        app.use(express.json({ verify: () => { parsedBodies++ } }))
        app.post('/api/patch', (_req: unknown, res: { json: (body: unknown) => void }) => {
            writes++
            res.json({ ok: true })
        })
        app.get('/api/read', (_req: unknown, res: { json: (body: unknown) => void }) => {
            res.json({ ok: true })
        })
        const server = await new Promise<import('node:http').Server>((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s))
        })
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        const patch = (build?: string) => fetch(`${base}/api/patch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(build ? { [BUILD_ID_HEADER]: build } : {}) },
            body: JSON.stringify({ patch: [] }),
        })
        return {
            server,
            base,
            patch,
            logger,
            counts: () => ({ parsedBodies, writes }),
        }
    }

    it('refuses a stale write before its body is parsed', async () => {
        fs.writeFileSync(file, 'b2\n')
        const s = await serve()
        try {
            const stale = await s.patch('b1')
            expect(stale.status).toBe(426)
            expect(await stale.json()).toMatchObject({ code: STALE_BUILD_CODE, serverBuild: 'b2' })
            expect(s.counts()).toEqual({ parsedBodies: 0, writes: 0 })
            // A second refusal from the same client build is not logged again.
            await s.patch('b1')
            expect(s.logger.warn).toHaveBeenCalledTimes(1)

            expect((await s.patch('b2')).status).toBe(200)
            expect((await s.patch()).status).toBe(200)
            expect(s.counts()).toEqual({ parsedBodies: 2, writes: 2 })

            const read = await fetch(`${s.base}/api/read`, { headers: { [BUILD_ID_HEADER]: 'b1' } })
            expect(read.status).toBe(200)
        } finally {
            await new Promise((resolve) => s.server.close(resolve))
        }
    })

    it('fails open without a build id file and follows a rebuild', async () => {
        const s = await serve()
        try {
            expect((await s.patch('b1')).status).toBe(200)
            // Sizes differ, so the rewrite is seen even within one mtime tick.
            fs.writeFileSync(file, 'b22\n')
            expect((await s.patch('b1')).status).toBe(426)
            fs.writeFileSync(file, 'b1\n')
            expect((await s.patch('b1')).status).toBe(200)
        } finally {
            await new Promise((resolve) => s.server.close(resolve))
        }
    })
})
