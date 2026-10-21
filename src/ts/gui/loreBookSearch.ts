// The search box above a lorebook list (the user's request, 2026-10-21):
// entries whose name, keys or content hold the text, in every folder.

type SearchableLore = { comment?: string, key?: string, secondkey?: string, content?: string, mode?: string }

/** The search text as matched: trimmed and lower-cased ('' shows the list as usual). */
export function loreSearchNeedle(query: string | null | undefined): string {
    return (query ?? '').trim().toLowerCase()
}

/** Whether an entry (not a folder) holds `needle` in its name, keys or content. */
export function loreBookMatches(book: SearchableLore, needle: string): boolean {
    if (!needle || book.mode === 'folder') return false
    return [book.comment, book.key, book.secondkey, book.content].some((text) => (text ?? '').toLowerCase().includes(needle))
}
