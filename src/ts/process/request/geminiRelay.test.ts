import { describe, expect, it } from 'vitest'
import { isGeminiRelayTarget, resolveGeminiRelay, routeGeminiThroughLaptop } from './geminiRelay'

const db = {
    geminiRelayMode: 'us' as const,
    geminiRelayUsUrl: 'https://us-relay.example',
    geminiRelayJpUrl: 'https://jp-relay.example',
    geminiRelayKey: 'secret',
}

describe('Gemini relay selection', () => {
    it('routes only Gemini requests in laptop mode on the Node server', () => {
        const target = 'https://generativelanguage.googleapis.com/v1/models'
        expect(routeGeminiThroughLaptop(target, { geminiRelayMode: 'laptop' }, true)).toBe(true)
        expect(routeGeminiThroughLaptop('https://example.com/v1', { geminiRelayMode: 'laptop' }, true)).toBe(false)
        for (const mode of ['off', 'us', 'jp'] as const) {
            expect(routeGeminiThroughLaptop(target, { geminiRelayMode: mode }, true)).toBe(false)
        }
        expect(routeGeminiThroughLaptop(target, { geminiRelayMode: 'laptop' }, false)).toBe(false)
    })

    it('allows only exact Google API hosts over HTTPS', () => {
        for (const url of [
            'https://aiplatform.googleapis.com/v1',
            'https://us-central1-aiplatform.googleapis.com/v1',
            'https://asia-northeast1-aiplatform.googleapis.com/v1',
            'https://generativelanguage.googleapis.com/v1',
        ]) expect(isGeminiRelayTarget(url)).toBe(true)
        for (const url of [
            'https://aiplatform.googleapis.com.evil.com/v1',
            'https://evil-aiplatform.googleapis.com.evil.com',
            'https://generativelanguage.googleapis.com.evil.com',
            'http://aiplatform.googleapis.com/v1',
            'https://user@aiplatform.googleapis.com/v1',
            'https://aiplatform.googleapis.com:4433/v1',
            'https://example.com/v1',
            'invalid',
        ]) expect(isGeminiRelayTarget(url)).toBe(false)
    })

    it('resolves mode, URL and key without touching other requests', () => {
        const target = 'https://aiplatform.googleapis.com/v1/test'
        expect(resolveGeminiRelay(target, db)).toEqual({ url: db.geminiRelayUsUrl,
            headers: { 'x-relay-target': target, 'x-relay-key': 'secret' } })
        expect(resolveGeminiRelay(target, { ...db, geminiRelayMode: 'jp' })).toMatchObject({ url: db.geminiRelayJpUrl })
        expect(resolveGeminiRelay(target, { ...db, geminiRelayMode: 'off' })).toBeNull()
        expect(resolveGeminiRelay(target, { ...db, geminiRelayMode: 'laptop' })).toBeNull()
        expect(resolveGeminiRelay(target, { ...db, geminiRelayMode: 'rotate' })).toBeNull()
        expect(resolveGeminiRelay(target, { ...db, geminiRelayUsUrl: '' })).toBeNull()
        expect(resolveGeminiRelay(target, { ...db, geminiRelayUsUrl: 'http://remote.example' })).toBeNull()
        expect(resolveGeminiRelay(target, { ...db, geminiRelayUsUrl: 'http://127.0.0.1:8080' })).not.toBeNull()
        expect(resolveGeminiRelay(target, { ...db, geminiRelayUsUrl: 'http://localhost:8080' })).not.toBeNull()
        expect(resolveGeminiRelay(target, { ...db, geminiRelayKey: '' })).toBeNull()
        expect(resolveGeminiRelay('https://example.com', db)).toBeNull()
    })

    it('uses defaults per empty field while database values win', () => {
        const target = 'https://aiplatform.googleapis.com/v1/test'
        const defaults = { usUrl: 'https://default-us.example.invalid', jpUrl: 'https://default-jp.example.invalid', key: 'default-fake-secret' }
        expect(resolveGeminiRelay(target, { ...db, geminiRelayUsUrl: '', geminiRelayKey: '' }, defaults))
            .toEqual({ url: defaults.usUrl, headers: { 'x-relay-target': target, 'x-relay-key': defaults.key } })
        expect(resolveGeminiRelay(target, { ...db, geminiRelayMode: 'jp', geminiRelayJpUrl: '' }, defaults))
            .toMatchObject({ url: defaults.jpUrl, headers: { 'x-relay-key': db.geminiRelayKey } })
        expect(resolveGeminiRelay(target, db, defaults))
            .toMatchObject({ url: db.geminiRelayUsUrl, headers: { 'x-relay-key': db.geminiRelayKey } })
        expect(resolveGeminiRelay(target, { ...db, geminiRelayUsUrl: '', geminiRelayKey: '' }, {})).toBeNull()
    })
})
