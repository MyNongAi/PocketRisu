import type { Database } from '../../storage/database.svelte'
import { isGeminiRelayTarget } from './geminiRelay'
import { currentGeminiRelayDefaults, type GeminiRelayDefaults } from './geminiRelayDefaults'

export type GeminiRotationRoute = { kind: 'normal' } | { kind: 'relay', url: string, headers: Record<string, string> }
type RotationDb = Pick<Database, 'geminiRelayMode' | 'geminiRelayRotateUrls' | 'geminiRelayUsUrl' | 'geminiRelayJpUrl' | 'geminiRelayKey'>

function validRelayUrl(value: string | undefined): value is string {
    if (!value) return false
    try {
        const parsed = new URL(value)
        return parsed.protocol === 'https:' || (parsed.protocol === 'http:' &&
            (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'))
    } catch { return false }
}

export function geminiRotationRoutes(url: string, db: RotationDb,
    defaults: GeminiRelayDefaults = currentGeminiRelayDefaults()): GeminiRotationRoute[] {
    const routes: GeminiRotationRoute[] = [{ kind: 'normal' }]
    const key = db.geminiRelayKey || defaults.key
    if (db.geminiRelayMode !== 'rotate' || !isGeminiRelayTarget(url) || !key) return routes
    const configured = (db.geminiRelayRotateUrls ?? '').split(/\r?\n/).map(line => line.trim()).filter(validRelayUrl)
    const candidates = configured.length ? configured : [db.geminiRelayUsUrl || defaults.usUrl, db.geminiRelayJpUrl || defaults.jpUrl]
    for (const relayUrl of new Set(candidates.filter(validRelayUrl))) {
        routes.push({ kind: 'relay', url: relayUrl, headers: { 'x-relay-target': url, 'x-relay-key': key } })
    }
    return routes
}

let currentIndex = 0
let routeCount = 0

/** Try each route once, keeping the route that worked as the next starting point. */
export async function runGeminiRotation(
    routes: readonly GeminiRotationRoute[],
    aborted: () => boolean,
    attempt: (route: GeminiRotationRoute) => Promise<Response>,
): Promise<Response> {
    if (!routes.length) throw new Error('No Gemini rotation routes')
    if (routeCount !== routes.length) { currentIndex = 0; routeCount = routes.length }
    const start = currentIndex
    for (let tried = 0; tried < routes.length; tried++) {
        const index = (start + tried) % routes.length
        const route = routes[index]
        let response: Response
        try {
            response = await attempt(route)
        } catch (error) {
            if (aborted() || (error as { name?: string })?.name === 'AbortError') throw error
            if (route.kind !== 'relay') throw error
            console.info('[GeminiRotate] ' + new URL(route.url).host + ': network error')
            currentIndex = (index + 1) % routes.length
            if (tried === routes.length - 1) throw error
            continue
        }
        if (response.status !== 429 && (response.status < 500 || response.status >= 600)) {
            currentIndex = index
            return response
        }
        if (aborted()) throw new DOMException('Request aborted', 'AbortError')
        console.info('[GeminiRotate] ' + (route.kind === 'normal' ? 'normal' : new URL(route.url).host) + ': ' + response.status)
        currentIndex = (index + 1) % routes.length
        if (tried === routes.length - 1) return response
        try { await response.body?.cancel() } catch { /* cancellation is best effort */ }
        continue
    }
    throw new Error('No Gemini rotation routes')
}

export function resetGeminiRotationForTests(): void { currentIndex = 0; routeCount = 0 }
