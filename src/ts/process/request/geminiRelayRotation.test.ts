import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { geminiRotationRoutes, resetGeminiRotationForTests, runGeminiRotation, type GeminiRotationRoute } from './geminiRelayRotation'

const target = 'https://aiplatform.googleapis.com/v1/test'
const defaults = { usUrl: 'https://default-us.example.invalid', jpUrl: 'https://default-jp.example.invalid', key: 'default-key' }
const db = { geminiRelayMode: 'rotate' as const, geminiRelayRotateUrls: '', geminiRelayUsUrl: 'https://us.example.invalid', geminiRelayJpUrl: 'https://jp.example.invalid', geminiRelayKey: 'test-key' }
const urls = (routes: GeminiRotationRoute[]) => routes.map(route => route.kind === 'normal' ? 'normal' : route.url)
const routes: GeminiRotationRoute[] = [{ kind: 'normal' }, { kind: 'relay', url: 'https://us.example.invalid', headers: {} }, { kind: 'relay', url: 'https://jp.example.invalid', headers: {} }]

beforeEach(() => { resetGeminiRotationForTests(); vi.spyOn(console, 'info').mockImplementation(() => {}) })
afterEach(() => vi.restoreAllMocks())

describe('Gemini rotation routes', () => {
    it('puts normal first and trims, filters, and deduplicates configured relay URLs', () => {
        const list = geminiRotationRoutes(target, { ...db, geminiRelayRotateUrls: ' https://one.example.invalid/a \ninvalid\nhttp://remote.example\nhttp://localhost:8080\nhttps://one.example.invalid/a\nhttp://127.0.0.1:8080' }, defaults)
        expect(urls(list)).toEqual(['normal', 'https://one.example.invalid/a', 'http://localhost:8080', 'http://127.0.0.1:8080'])
        expect(list[1]).toMatchObject({ headers: { 'x-relay-target': target, 'x-relay-key': 'test-key' } })
    })
    it('uses US and Japan fields, then defaults, when no configured line is valid', () => {
        expect(urls(geminiRotationRoutes(target, { ...db, geminiRelayRotateUrls: 'bad\nhttp://remote.example' }, defaults)))
            .toEqual(['normal', db.geminiRelayUsUrl, db.geminiRelayJpUrl])
        expect(urls(geminiRotationRoutes(target, { ...db, geminiRelayUsUrl: '', geminiRelayJpUrl: '' }, defaults)))
            .toEqual(['normal', defaults.usUrl, defaults.jpUrl])
    })
    it('uses trimmed, filtered, deduplicated file URLs before US and Japan fields', () => {
        const fileDefaults = { ...defaults, rotateUrls: [
            ' https://first.example.invalid/a ', 'invalid', 'http://remote.example.invalid',
            'https://first.example.invalid/a', 'https://second.example.invalid',
        ] }
        const list = geminiRotationRoutes(target, db, fileDefaults)
        expect(urls(list)).toEqual(['normal', 'https://first.example.invalid/a', 'https://second.example.invalid'])
        expect(list[1]).toMatchObject({ headers: { 'x-relay-key': 'test-key' } })
        expect(urls(geminiRotationRoutes(target, { ...db, geminiRelayRotateUrls: 'bad' },
            { ...defaults, rotateUrls: ['invalid'] }))).toEqual(['normal', db.geminiRelayUsUrl, db.geminiRelayJpUrl])
    })
    it('uses a non-empty setting before the file rotation list', () => {
        const list = geminiRotationRoutes(target,
            { ...db, geminiRelayRotateUrls: ' https://setting.example.invalid ' },
            { ...defaults, rotateUrls: ['https://file.example.invalid'] })
        expect(urls(list)).toEqual(['normal', 'https://setting.example.invalid'])
    })
    it('uses only normal without a key, in another mode, or for another target', () => {
        expect(urls(geminiRotationRoutes(target, { ...db, geminiRelayKey: '' }, {}))).toEqual(['normal'])
        expect(urls(geminiRotationRoutes(target, { ...db, geminiRelayMode: 'off' }, defaults))).toEqual(['normal'])
        expect(urls(geminiRotationRoutes('https://example.invalid', db, defaults))).toEqual(['normal'])
    })
})

describe('Gemini rotation loop', () => {
    it('cancels a 429 response, returns the 200, and starts there next time', async () => {
        const cancel = vi.fn()
        const failed = new Response(new ReadableStream({ cancel }), { status: 429 })
        const seen: string[] = []
        const attempt = vi.fn(async (route: GeminiRotationRoute) => {
            seen.push(route.kind === 'normal' ? 'normal' : route.url)
            return seen.length === 1 ? failed : new Response('ok')
        })
        expect((await runGeminiRotation(routes, () => false, attempt)).status).toBe(200)
        expect(cancel).toHaveBeenCalledOnce()
        await runGeminiRotation(routes, () => false, attempt)
        expect(seen).toEqual(['normal', 'https://us.example.invalid', 'https://us.example.invalid'])
    })
    it('rotates on 5xx and a relay network error', async () => {
        const seen: string[] = []
        const result = await runGeminiRotation(routes, () => false, async route => {
            seen.push(route.kind)
            if (seen.length === 1) return new Response(null, { status: 503 })
            if (seen.length === 2) throw new TypeError('network')
            return new Response('ok')
        })
        expect(result.status).toBe(200)
        expect(seen).toEqual(['normal', 'relay', 'relay'])
    })
    it('returns a 400 at once', async () => {
        const attempt = vi.fn(async () => new Response(null, { status: 400 }))
        expect((await runGeminiRotation(routes, () => false, attempt)).status).toBe(400)
        expect(attempt).toHaveBeenCalledOnce()
    })
    it('rethrows an abort without another attempt', async () => {
        const attempt = vi.fn(async () => { throw new DOMException('stopped', 'AbortError') })
        await expect(runGeminiRotation(routes, () => true, attempt)).rejects.toMatchObject({ name: 'AbortError' })
        expect(attempt).toHaveBeenCalledOnce()
    })
    it('returns the last failed response with its body intact', async () => {
        const cancel = vi.fn()
        const last = new Response(new ReadableStream({ cancel }), { status: 429 })
        let count = 0
        const result = await runGeminiRotation(routes, () => false, async () => ++count === routes.length ? last : new Response(null, { status: 503 }))
        expect(result).toBe(last)
        expect(cancel).not.toHaveBeenCalled()
        expect(count).toBe(routes.length)
    })
    it('resets the sticky start when the route count changes', async () => {
        await runGeminiRotation(routes, () => false, async route => new Response(null, { status: route.kind === 'normal' ? 429 : 200 }))
        const seen: string[] = []
        await runGeminiRotation(routes.slice(0, 2), () => false, async route => {
            seen.push(route.kind)
            return new Response('ok')
        })
        expect(seen).toEqual(['normal'])
    })
})
