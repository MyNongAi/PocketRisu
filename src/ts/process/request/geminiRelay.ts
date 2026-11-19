import type { Database } from '../../storage/database.svelte'
import { currentGeminiRelayDefaults, type GeminiRelayDefaults } from './geminiRelayDefaults'

export function isGeminiRelayTarget(raw: string): boolean {
    try {
        const url = new URL(raw)
        return url.protocol === 'https:' && !url.username && !url.password && !url.port && (
            url.hostname === 'aiplatform.googleapis.com' ||
            /^[a-z0-9-]+-aiplatform\.googleapis\.com$/.test(url.hostname) ||
            url.hostname === 'generativelanguage.googleapis.com'
        )
    } catch { return false }
}

export function resolveGeminiRelay(url: string, db: Pick<Database,
    'geminiRelayMode' | 'geminiRelayUsUrl' | 'geminiRelayJpUrl' | 'geminiRelayKey'>,
    defaults: GeminiRelayDefaults = currentGeminiRelayDefaults()) {
    const key = db.geminiRelayKey || defaults.key
    if (!isGeminiRelayTarget(url) || !key) return null
    const relayUrl = db.geminiRelayMode === 'us' ? (db.geminiRelayUsUrl || defaults.usUrl)
        : db.geminiRelayMode === 'jp' ? (db.geminiRelayJpUrl || defaults.jpUrl) : ''
    try {
        const parsed = new URL(relayUrl ?? '')
        const local = parsed.protocol === 'http:' &&
            (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
        if (!relayUrl || (parsed.protocol !== 'https:' && !local)) return null
        return { url: relayUrl, headers: { 'x-relay-target': url, 'x-relay-key': key } }
    } catch { return null }
}
