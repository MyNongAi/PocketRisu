// KO-VIEW (2026-11-22): Korean reading notes never replace prompt source text.

export type KoEntry = { text: string, src: string }
export type KoMap = Record<string, KoEntry>
export type KoOwner = { nodeOnlyKo?: KoMap }

export function fingerprint(text: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

export function isKoStale(entry: KoEntry | undefined, english: string): boolean {
    return !!entry && entry.src !== fingerprint(english)
}

export function setKoEntry(owner: KoOwner, key: string, entry: KoEntry | undefined): void {
    if (entry) (owner.nodeOnlyKo ??= {})[key] = entry
    else if (owner.nodeOnlyKo) {
        delete owner.nodeOnlyKo[key]
        if (Object.keys(owner.nodeOnlyKo).length === 0) delete owner.nodeOnlyKo
    }
}

export function validKoMap(input: unknown): KoMap | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
    const map: KoMap = {}
    for (const [key, value] of Object.entries(input)) {
        if (key.length > 100 || !value || typeof value !== 'object' || Array.isArray(value)) continue
        const item = value as Record<string, unknown>
        if (typeof item.text === 'string' && typeof item.src === 'string' && item.text.length <= 200_000 && item.src.length <= 100) {
            map[key] = { text: item.text, src: item.src }
        }
    }
    return Object.keys(map).length ? map : undefined
}

export function sanitizeKoEntries(entries: KoOwner[]): void {
    for (const entry of entries) {
        const ko = validKoMap(entry.nodeOnlyKo)
        if (ko) entry.nodeOnlyKo = ko
        else delete entry.nodeOnlyKo
    }
}

export function maskKoMarkup(input: string): { text: string, restore: (translated: string) => string } {
    const tokens: string[] = []
    let output = ''
    for (let i = 0; i < input.length;) {
        let end = -1
        if (input.startsWith('{{', i)) {
            let depth = 1
            for (let j = i + 2; j < input.length - 1; j++) {
                if (input.startsWith('{{', j)) { depth++; j++ }
                else if (input.startsWith('}}', j)) { depth--; j++; if (!depth) { end = j + 1; break } }
            }
        } else if (input[i] === '<') {
            const close = input.indexOf('>', i + 1)
            if (close >= 0 && !input.slice(i, close).includes('\n')) end = close + 1
        }
        if (end > i) {
            const index = tokens.push(input.slice(i, end)) - 1
            output += `⟦${index}⟧`
            i = end
        } else output += input[i++]
    }
    return { text: output, restore: translated => translated.replace(/⟦(\d+)⟧/g, (match, n) => tokens[Number(n)] ?? match) }
}

export function chunkKoText(input: string, limit: number): string[] {
    if (!input) return []
    const chunks: string[] = []
    let current = ''
    const push = (part: string) => {
        while (part.length > limit) {
            const slice = part.slice(0, limit)
            const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '))
            const cut = sentence > limit / 3 ? sentence + 2 : limit
            if (current) { chunks.push(current); current = '' }
            chunks.push(part.slice(0, cut))
            part = part.slice(cut)
        }
        if (current && current.length + part.length > limit) { chunks.push(current); current = '' }
        current += part
    }
    for (const line of input.match(/[^\n]*\n|[^\n]+$/g) ?? []) push(line)
    if (current) chunks.push(current)
    return chunks
}
