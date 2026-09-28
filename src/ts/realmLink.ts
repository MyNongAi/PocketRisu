// Realm character references a user pastes: a page URL
// (https://realm.risuai.net/character/<id>, scheme optional), any link that
// carries ?realm= or ?code= (the app's own share links), or a bare id.

const REALM_HOSTS = /(^|\.)risuai\.(net|xyz)$/i
const SCHEMELESS_REALM = /^(realm\.)?risuai\.(net|xyz)\//i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The Realm id in `input`, or null.
 *
 * `bareIds` decides what a value that is not a link counts as: 'any' for an
 * explicit "import by address or id" prompt, 'uuid' for a search box, where a
 * word is a search and only an id-shaped value is taken as an id.
 */
export function parseRealmReference(input: string, bareIds: 'any' | 'uuid' = 'any'): string | null {
    const text = input.trim()
    if (!text) return null
    const link = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
        ? text
        : SCHEMELESS_REALM.test(text) ? `https://${text}` : null
    if (link) {
        let url: URL
        try {
            url = new URL(link)
        } catch {
            return null
        }
        const fromQuery = (url.searchParams.get('realm') ?? url.searchParams.get('code'))?.trim()
        if (fromQuery) return fromQuery
        if (!REALM_HOSTS.test(url.hostname)) return null
        // /character/<id>: the id is the last segment of a two-or-more segment path.
        const segments = url.pathname.split('/').filter(Boolean)
        if (segments.length < 2) return null
        try {
            return decodeURIComponent(segments[segments.length - 1]) || null
        } catch {
            return null
        }
    }
    if (/\s/.test(text)) return null
    if (bareIds === 'uuid') return UUID.test(text) ? text : null
    return text
}
