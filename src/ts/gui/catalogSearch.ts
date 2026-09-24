/**
 * Korean-aware catalog filtering, inspired by HaejeokRisu's koreanSearch.ts
 * (6c52c34b, GPL-3.0). This intentionally adopts only deterministic title
 * matching, not romanization, keyboard conversion, ranking or DB changes.
 */
const INITIALS = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
const matchers = new Map<string, (target: string) => boolean>()
const MAX_QUERIES = 64

function normalize(text: string): string {
    return text.normalize('NFC').toLowerCase().replace(/\s+/gu, '').replace(/[ᄀ-ᄒ]/g,
        initial => INITIALS[initial.charCodeAt(0) - 0x1100])
}

function compile(query: string): (target: string) => boolean {
    const normalized = normalize(query)
    if (!normalized) return () => true
    // Large pasted queries remain literal; don't compile an unbounded regex.
    if (normalized.length > 256) return target => normalize(target).includes(normalized)
    const chars = Array.from(normalized)
    const pattern = chars.map((char, index) => {
        const initial = INITIALS.indexOf(char)
        if (initial !== -1) {
            const start = 0xac00 + initial * 588
            return `[${char}${String.fromCharCode(start)}-${String.fromCharCode(start + 587)}]`
        }
        const code = char.charCodeAt(0)
        // Only the final syllable may still be under IME composition. Don't
        // broaden every completed syllable and match unrelated names.
        if (index === chars.length - 1 && code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 === 0) {
            return `[${char}-${String.fromCharCode(code + 27)}]`
        }
        return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }).join('')
    const regex = new RegExp(pattern, 'u')
    return target => regex.test(normalize(target))
}

/** Retain only bounded query matchers, never the full cards or their text. */
export function matchesCatalogText(target: string | null | undefined, query: string): boolean {
    let matches = matchers.get(query)
    if (!matches) {
        matches = compile(query)
        if (query.length <= 256) {
            matchers.set(query, matches)
            if (matchers.size > MAX_QUERIES) matchers.delete(matchers.keys().next().value!)
        }
    } else {
        matchers.delete(query)
        matchers.set(query, matches)
    }
    return matches(target ?? '')
}
