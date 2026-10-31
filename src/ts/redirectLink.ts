// Some sites send their outbound links through a warning page: arca.live
// writes https://unsafelink.com/<the link>. A link copied or dragged from
// such a post means the link inside (the user's request, 2026-10-31).

const WRAPPER = /^https?:\/\/(www\.)?unsafelink\.com\//i

/** The link inside a known redirect wrapper, else `text` trimmed. */
export function unwrapRedirectLink(text: string): string {
    const link = text.trim()
    if (!WRAPPER.test(link)) return link
    let inner = link.replace(WRAPPER, '')
    // An encoded link (https%3A%2F%2F...) decodes; a plain one keeps its own escapes.
    if (/^https?%3A/i.test(inner)) {
        try {
            inner = decodeURIComponent(inner)
        } catch {
            return link
        }
    }
    return inner || link
}
