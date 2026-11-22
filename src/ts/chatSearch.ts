// CHAT-SEARCH (2026-11-22): pure message matching and safe snippet parts.
export interface SnippetPart { text: string; hit: boolean }
export interface Snippet { parts: SnippetPart[]; text: string }

// Like Ctrl+F the query is one phrase: "입력 6" finds that text, not every
// message holding "입력" and a "6" somewhere (a UUID, say). Runs of spaces and
// line breaks count as one space on both sides.
export function searchTerms(query: string): string[] {
    const phrase = query.trim().toLocaleLowerCase().replace(/\s+/gu, ' ')
    return phrase ? [phrase] : []
}

// The branch button's "branched from" card is a message of its own; its text
// is an id, not something written.
export function isSearchableMessage(data: string): boolean {
    return !data.trimStart().startsWith('{{specialcomment::')
}

export function messageMatches(data: string, terms: string[]): boolean {
    if (!terms.length || !isSearchableMessage(data)) return false
    const lower = data.toLocaleLowerCase().replace(/\s+/gu, ' ')
    return terms.every(term => lower.includes(term))
}

export function messageSnippet(data: string, terms: string[]): Snippet {
    if (!terms.length) return { parts: [], text: '' }
    const clean = data.replace(/\s+/gu, ' ')
    const lower = clean.toLocaleLowerCase()
    const found = terms.map(term => ({ at: lower.indexOf(term), length: term.length })).filter(match => match.at >= 0)
    const first = Math.min(...found.map(match => match.at))
    if (!Number.isFinite(first)) return { parts: [], text: '' }
    const start = Math.max(0, first - 30)
    const end = Math.min(clean.length, first + Math.max(...found.filter(match => match.at === first).map(match => match.length)) + 80)
    const text = `${start ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`
    const folded = text.toLocaleLowerCase()
    const hits = new Array(text.length).fill(false) as boolean[]
    for (const term of terms) {
        let at = 0
        while ((at = folded.indexOf(term, at)) !== -1) {
            for (let i = at; i < Math.min(at + term.length, hits.length); i++) hits[i] = true
            at += 1
        }
    }
    const parts: SnippetPart[] = []
    for (let i = 0; i < text.length;) {
        const hit = hits[i]
        let j = i + 1
        while (j < text.length && hits[j] === hit) j++
        parts.push({ text: text.slice(i, j), hit })
        i = j
    }
    return { parts, text }
}
