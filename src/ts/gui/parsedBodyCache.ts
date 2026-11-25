// CHAT-BODY-RESUME (2026-11-25): Keep only recent rendered bodies in memory.
const MAX_BODIES = 300
const bodies = new Map<string, string>()

export interface ParsedBodyIdentity {
    chatId?: string
    messageId?: string
    index: number
    source: string
    mode: string
    translated: boolean
    hideAllImages: boolean
    resolveAssets: boolean
}

function hashText(text: string): string {
    let hash = 2166136261
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return `${text.length}:${(hash >>> 0).toString(16)}`
}

export function parsedBodyKey(value: ParsedBodyIdentity): string {
    return JSON.stringify([
        value.chatId ?? '', value.messageId || `index:${value.index}`,
        hashText(value.source), value.mode, value.translated,
        value.hideAllImages, value.resolveAssets,
    ])
}

export function getParsedBody(key: string): string | undefined {
    const value = bodies.get(key)
    if (value !== undefined) {
        bodies.delete(key)
        bodies.set(key, value)
    }
    return value
}

export function putParsedBody(key: string, html: string): void {
    if (!html.trim()) return
    bodies.delete(key)
    bodies.set(key, html)
    if (bodies.size > MAX_BODIES) bodies.delete(bodies.keys().next().value!)
}

export function plainBodyHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;').replace(/\r\n?|\n/g, '<br>')
}

export function pendingBodyNeedsRestart(startedAt: number | null, now: number): boolean {
    return startedAt !== null && now - startedAt > 3000
}

export function withFallbackTimeout<T, F = T>(work: Promise<T>, milliseconds: number, fallback: () => F | Promise<F>): Promise<T | F> {
    return new Promise<T | F>((resolve, reject) => {
        let settled = false
        const finish = (callback: () => void) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            callback()
        }
        const timer = setTimeout(() => {
            finish(() => Promise.resolve().then(fallback).then(resolve, reject))
        }, milliseconds)
        work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
    })
}
