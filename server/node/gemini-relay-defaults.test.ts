import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import express from 'express'

const { createGeminiRelayDefaults } = require('./gemini-relay-defaults.cjs')

describe('Gemini relay local defaults route', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gemini-relay-defaults-'))
    const filePath = join(dir, 'gemini-relay.local.json')
    const warn = vi.fn()
    let server: http.Server
    let base: string

    beforeAll(async () => {
        const app = express()
        createGeminiRelayDefaults({ filePath, logger: { warn } }).registerRoutes(app, {
            auth: (req: express.Request, res: express.Response) => {
                if (req.headers['risu-auth'] === 'test-token') return true
                res.status(401).json({ error: 'unauthorized' })
                return false
            },
        })
        server = http.createServer(app)
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        base = `http://127.0.0.1:${(server.address() as any).port}`
    })
    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        rmSync(dir, { recursive: true, force: true })
    })
    beforeEach(() => {
        rmSync(filePath, { force: true })
        warn.mockClear()
    })

    const request = (authenticated = true) => fetch(`${base}/api/gemini-relay-defaults`, {
        headers: authenticated ? { 'risu-auth': 'test-token' } : {},
    })

    it('requires auth and sends no-store', async () => {
        const response = await request(false)
        expect(response.status).toBe(401)
        expect(response.headers.get('cache-control')).toBe('no-store')
    })
    it('returns an empty object when the file is missing', async () => {
        expect(await (await request()).json()).toEqual({})
        expect(warn).not.toHaveBeenCalled()
    })
    it('reads valid values on every request', async () => {
        const rotateUrls = ['https://first.example.invalid', 'https://second.example.invalid']
        writeFileSync(filePath, JSON.stringify({ jpUrl: 'https://jp.example.invalid', rotateUrls, key: 'fake-secret-123456' }))
        expect(await (await request()).json()).toEqual({ jpUrl: 'https://jp.example.invalid', rotateUrls, key: 'fake-secret-123456' })
        writeFileSync(filePath, JSON.stringify({ usUrl: 'https://us.example.invalid' }))
        expect(await (await request()).json()).toEqual({ usUrl: 'https://us.example.invalid' })
    })
    it.each([
        '{',
        JSON.stringify({ jpUrl: 'http://jp.example.invalid', key: 'fake-secret-123456' }),
        JSON.stringify({ jpUrl: 'https://jp.example.invalid', key: 'short' }),
        JSON.stringify({ jpUrl: 'https://jp.example.invalid', rotateUrls: ['http://first.example.invalid'] }),
        JSON.stringify({ jpUrl: 'https://jp.example.invalid', rotateUrls: ['https://first.example.invalid', 42] }),
    ])('rejects invalid files without exposing values in the warning', async (source) => {
        writeFileSync(filePath, source)
        expect(await (await request()).json()).toEqual({})
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn.mock.calls[0][0]).toBe('[gemini-relay-defaults] Invalid local defaults file')
    })
})
