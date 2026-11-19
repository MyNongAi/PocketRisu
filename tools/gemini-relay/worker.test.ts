import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { allowedTarget } from './worker.mjs'

const env = { RELAY_KEY: '0123456789abcdef' }
const target = 'https://aiplatform.googleapis.com/v1/projects/example/locations/global/publishers/google/models/test:streamGenerateContent'

afterEach(() => { vi.unstubAllGlobals() })

describe('Gemini relay worker', () => {
    it('answers preflight and health without a key', async () => {
        const pre = await worker.fetch(new Request('https://relay.example/x', { method: 'OPTIONS', headers: {
            Origin: 'https://app.example', 'Access-Control-Request-Headers': 'authorization,x-relay-key,x-relay-target',
        } }), env)
        expect(pre.status).toBe(204)
        expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.example')
        expect(pre.headers.get('access-control-allow-headers')).toBe('authorization,x-relay-key,x-relay-target')
        const health = await worker.fetch(new Request('https://relay.example/health'), env)
        expect(await health.json()).toEqual({ ok: true, colo: '' })
    })

    it('refuses a missing key, a wrong key, an unset secret and non-Google targets', async () => {
        const call = (headers: Record<string, string>, e: Record<string, string> = env) => worker.fetch(new Request('https://relay.example/', { method: 'POST', headers, body: '{}' }), e)
        expect((await call({ 'x-relay-target': target })).status).toBe(401)
        expect((await call({ 'x-relay-key': 'wrong', 'x-relay-target': target })).status).toBe(401)
        expect((await call({ 'x-relay-key': env.RELAY_KEY, 'x-relay-target': target }, {})).status).toBe(500)
        for (const bad of ['https://example.com/', 'https://aiplatform.googleapis.com.evil.com/', 'http://aiplatform.googleapis.com/']) {
            expect((await call({ 'x-relay-key': env.RELAY_KEY, 'x-relay-target': bad })).status).toBe(403)
        }
        expect(allowedTarget('https://us-central1-aiplatform.googleapis.com/v1/x')?.hostname).toBe('us-central1-aiplatform.googleapis.com')
    })

    it('forwards only safe headers and streams the answer back with CORS', async () => {
        let seen: { url: string, headers: Headers, body: string } | undefined
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            seen = { url, headers: new Headers(init.headers), body: await new Response(init.body).text() }
            return new Response('data: one\n\ndata: two\n\n', { status: 429, headers: { 'content-type': 'text/event-stream', 'x-goog-test': 'kept', connection: 'close' } })
        }))
        const res = await worker.fetch(new Request('https://relay.example/', { method: 'POST', body: '{"contents":[]}', headers: {
            Origin: 'https://app.example', 'x-relay-key': env.RELAY_KEY, 'x-relay-target': target,
            authorization: 'Bearer test', 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7',
            'x-forwarded-for': '198.51.100.7', 'x-real-ip': '198.51.100.7', cookie: 'a=b', 'accept-encoding': 'gzip, br, zstd',
        } }), env)
        expect(res.status).toBe(429)
        expect(await res.text()).toBe('data: one\n\ndata: two\n\n')
        expect(res.headers.get('x-goog-test')).toBe('kept')
        expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example')
        expect(seen?.url).toBe(target)
        expect(seen?.body).toBe('{"contents":[]}')
        expect(seen?.headers.get('authorization')).toBe('Bearer test')
        for (const name of ['x-relay-key', 'x-relay-target', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'cookie', 'origin', 'accept-encoding']) {
            expect(seen?.headers.has(name)).toBe(false)
        }
    })
})
