// Where a search text occurs in a field's text, for the marks drawn behind a
// text field (TextareaMarks.svelte): the lorebook search and a field's own
// find bar (the user's request, 2026-10-26).

export type TextMatch = [start: number, end: number]

/** Marks past this many are not drawn: a one-letter search in a long text would build thousands. */
export const MAX_TEXT_MATCHES = 500

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every place `needle` occurs in `text`, ignoring case; none for an empty or blank needle. */
export function findTextMatches(text: string | null | undefined, needle: string | null | undefined, limit = MAX_TEXT_MATCHES): TextMatch[] {
    const source = text ?? ''
    const term = needle ?? ''
    if (!source || !term.trim()) return []
    const pattern = new RegExp(escapeRegExp(term), 'giu')
    const matches: TextMatch[] = []
    for (const match of source.matchAll(pattern)) {
        if (matches.length >= limit) break
        const start = match.index ?? 0
        matches.push([start, start + match[0].length])
    }
    return matches
}

export type TextSegment = { text: string, mark: number }

/** `text` cut at the matches: a segment's `mark` is its match's index, or -1 between matches. */
export function splitAtMatches(text: string, matches: readonly TextMatch[]): TextSegment[] {
    const segments: TextSegment[] = []
    let at = 0
    matches.forEach(([start, end], index) => {
        if (start < at || end <= start) return
        if (start > at) segments.push({ text: text.slice(at, start), mark: -1 })
        segments.push({ text: text.slice(start, end), mark: index })
        at = end
    })
    if (at < text.length) segments.push({ text: text.slice(at), mark: -1 })
    return segments
}

/** The match after (step 1) or before (step -1) `current`, wrapping at both ends; -1 without matches. */
export function stepMatch(current: number, count: number, step: 1 | -1): number {
    if (count <= 0) return -1
    if (current < 0 || current >= count) return step === 1 ? 0 : count - 1
    return (current + step + count) % count
}
