import { createRequire } from 'node:module'
import http from 'node:http'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { isBackgroundRequest, createUseTracker, requestLaptopRestart } = require('./laptop-switch.cjs')
const { isMutatingRequest } = require('./build-fence.cjs')

describe('isBackgroundRequest', () => {
    it('leaves out what an untouched tab and the switch send', () => {
        for (const p of ['/api/sync/events', '/api/import/watch-downloads', '/api/chat-session/a/b/claim',
            '/api/session/lock-status', '/api/token/refresh', '/api/laptop/activity', '/build-id.txt']) {
            expect(isBackgroundRequest(p), p).toBe(true)
        }
    })

    it('counts everything else', () => {
        for (const p of ['/', '/api/write', '/api/patch', '/proxy-stream-jobs', '/api/chat-session/a/b', '/api/laptop/restart']) {
            expect(isBackgroundRequest(p), p).toBe(false)
        }
    })
})

describe('createUseTracker', () => {
    function fakeRes() {
        return new EventEmitter()
    }

    it('counts a request from its start to its end', () => {
        let clock = 1000
        const tracker = createUseTracker({ now: () => clock })
        const res = fakeRes()
        clock = 2000
        tracker.middleware({ path: '/api/write' }, res, () => {})
        expect(tracker.snapshot()).toEqual({ lastUseAt: 2000, inFlight: 1, now: 2000 })
        clock = 9000
        res.emit('close')
        expect(tracker.snapshot()).toEqual({ lastUseAt: 9000, inFlight: 0, now: 9000 })
    })

    it('ignores background requests', () => {
        let clock = 1000
        const tracker = createUseTracker({ now: () => clock })
        clock = 5000
        let passed = false
        tracker.middleware({ path: '/api/sync/events' }, fakeRes(), () => { passed = true })
        expect(passed).toBe(true)
        expect(tracker.snapshot()).toEqual({ lastUseAt: 1000, inFlight: 0, now: 5000 })
    })
})

describe('requestLaptopRestart', () => {
    let server: http.Server | null = null
    afterEach(() => new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve() }))

    function standIn(reply: (req: http.IncomingMessage) => [number, unknown]) {
        const seen: http.IncomingMessage[] = []
        server = http.createServer((req, res) => {
            seen.push(req)
            const [status, body] = reply(req)
            res.writeHead(status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(body))
        })
        return new Promise<{ url: string; seen: http.IncomingMessage[] }>((resolve) => {
            server!.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen }))
        })
    }

    it('posts to /restart with the header and the folder it runs from', async () => {
        const { url, seen } = await standIn(() => [202, { result: 'started' }])
        const result = await requestLaptopRestart({ switchUrl: url, root: 'C:\\PoketRisu' })
        expect(result).toEqual({ status: 202, body: { result: 'started' } })
        expect(seen[0].method).toBe('POST')
        expect(seen[0].url).toBe('/restart')
        expect(seen[0].headers['x-pocketrisu-remote']).toBe('1')
        expect(decodeURIComponent(String(seen[0].headers['x-pocketrisu-root']))).toBe(path.resolve('C:\\PoketRisu'))
    })

    it('passes the switch refusal on', async () => {
        const { url } = await standIn(() => [409, { result: 'other-install' }])
        expect(await requestLaptopRestart({ switchUrl: url })).toEqual({ status: 409, body: { result: 'other-install' } })
    })

    it('reports status 0 when there is no switch', async () => {
        const { url } = await standIn(() => [200, {}])
        await new Promise<void>((resolve) => server!.close(() => resolve()))
        server = null
        expect(await requestLaptopRestart({ switchUrl: url, timeoutMs: 2000 })).toEqual({ status: 0, body: null })
    })
})

describe('build fence', () => {
    it('lets a tab on an older build ask for the restart', () => {
        expect(isMutatingRequest('POST', '/api/laptop/restart')).toBe(false)
    })
})
