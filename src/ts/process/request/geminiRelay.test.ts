import { describe, expect, it } from 'vitest'
import { isGeminiRelayTarget, resolveGeminiRelay } from './geminiRelay'

const db = {
    geminiRelayMode: 'us' as const,
    geminiRelayUsUrl: 'https://us-relay.example',
    geminiRelayJpUrl: 'https://jp-relay.example',
    geminiRelayKey: 'secret',
}

describe('Gemini relay selection', () => {
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
        expect(resolveGeminiRelay(target, { ...db, geminiRelayUsUrl: '' })).toBeNull()
        expect(resolveGeminiRelay(target, { ...db, geminiRelayUsUrl: 'http://remote.example' })).toBeNull()
        expect(resolveGeminiRelay(target, { ...db, geminiRelayUsUrl: 'http://127.0.0.1:8080' })).not.toBeNull()
        expect(resolveGeminiRelay(target, { ...db, geminiRelayUsUrl: 'http://localhost:8080' })).not.toBeNull()
        expect(resolveGeminiRelay(target, { ...db, geminiRelayKey: '' })).toBeNull()
        expect(resolveGeminiRelay('https://example.com', db)).toBeNull()
    })
})
