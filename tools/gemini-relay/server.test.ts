import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { createRelayHandler } from './server.mjs'

const key = '0123456789abcdef'
const servers: Server[] = []

async function start(fetchImpl: typeof fetch = vi.fn(async () => new Response('ok'))) {
    const server = createServer(createRelayHandler({ key, fetchImpl, region: 'us-central1' }))
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing port')
    return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('Gemini relay', () => {
    it('answers preflight and health without a key', async () => {
        const base = await start()
        const preflight = await fetch(base + '/anything', { method: 'OPTIONS', headers: {
            Origin: 'https://app.example', 'Access-Control-Request-Headers': 'authorization,x-relay-key,x-relay-target',
        } })
        expect(preflight.status).toBe(204)
        expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example')
        expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS')
        expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization,x-relay-key,x-relay-target')
        expect(preflight.headers.get('access-control-max-age')).toBe('3600')
        expect(await (await fetch(base + '/health')).json()).toEqual({ ok: true, region: 'us-central1' })
    })

    it('rejects missing and incorrect keys and non-Google hosts', async () => {
        const base = await start()
        const target = 'https://aiplatform.googleapis.com/v1/test'
        for (const headers of [{ 'x-relay-target': target }, { 'x-relay-key': 'wrong', 'x-relay-target': target }]) {
            expect((await fetch(base, { headers })).status).toBe(401)
        }
        for (const bad of ['https://example.com', 'https://aiplatform.googleapis.com.evil.com']) {
            expect((await fetch(base, { headers: { 'x-relay-key': key, 'x-relay-target': bad } })).status).toBe(403)
        }
        const unconfigured = createServer(createRelayHandler({ key: 'short' }))
        servers.push(unconfigured)
        unconfigured.listen(0, '127.0.0.1')
        await once(unconfigured, 'listening')
        const address = unconfigured.address()
        if (!address || typeof address === 'string') throw new Error('missing port')
        expect((await fetch(`http://127.0.0.1:${address.port}`, { headers: { 'x-relay-key': 'short', 'x-relay-target': target } })).status).toBe(500)
    })

    it('forwards a regional request with only permitted headers and streams status/body', async () => {
        let captured: { url: string, init: RequestInit } | undefined
        const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            captured = { url: String(url), init: init! }
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('first'))
                    setTimeout(() => { controller.enqueue(new TextEncoder().encode('second')); controller.close() }, 10)
                },
            })
            return new Response(stream, { status: 207, headers: {
                'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'x-test': 'kept',
            } })
        }) as typeof fetch
        const base = await start(fetchImpl)
        const response = await fetch(base, { method: 'POST', headers: {
            'x-relay-key': key, 'x-relay-target': 'https://us-central1-aiplatform.googleapis.com/v1/test',
            'authorization': 'Bearer test', 'content-type': 'application/json', 'x-forwarded-test': 'drop',
            'x-cloud-trace-context': 'drop', 'traceparent': 'drop', 'referer': 'https://app.example',
            'cookie': 'drop', 'x-custom': 'keep', 'accept-encoding': 'gzip, deflate, br, zstd',
        }, body: '{"ok":true}' })
        expect(response.status).toBe(207)
        expect(response.headers.get('x-test')).toBe('kept')
        expect(response.headers.get('content-encoding')).toBeNull()
        expect(response.headers.get('access-control-expose-headers')).toBe('*')
        expect(await response.text()).toBe('firstsecond')
        expect(captured?.url).toBe('https://us-central1-aiplatform.googleapis.com/v1/test')
        const forwarded = captured?.init.headers as Headers
        expect(forwarded.get('authorization')).toBe('Bearer test')
        expect(forwarded.get('x-custom')).toBe('keep')
        for (const name of ['host', 'content-length', 'x-relay-key', 'x-relay-target', 'x-forwarded-test', 'x-cloud-trace-context', 'traceparent', 'referer', 'cookie', 'accept-encoding']) {
            expect(forwarded.has(name)).toBe(false)
        }
        expect(Buffer.from(captured?.init.body as Buffer).toString()).toBe('{"ok":true}')
    })
})
