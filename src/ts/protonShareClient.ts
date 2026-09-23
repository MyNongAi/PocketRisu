// Calls to the server's Proton share endpoints (server/node/proton). The server
// does the Proton handshake and decryption; this side only lists, previews and
// streams what it returns.

import { language } from 'src/lang'
import { forageStorage } from './globalApi.svelte'
import type { ImportProgressReporter } from './importProgress'

export interface ProtonEntry {
    name: string
    linkId: string
    /** 1 = folder, 2 = file */
    type: number
    size: number | null
    mediaType: string | null
    /** Proton keeps a small preview for this file. Older servers omit it. */
    hasThumbnail?: boolean
}

export interface ProtonFolderStep {
    linkId: string
    name: string
}

export interface ProtonInspectResult {
    kind: 'file' | 'folder'
    name: string
    /** Folders between the shared folder and this listing, outermost first. */
    trail: ProtonFolderStep[]
    entries: ProtonEntry[]
}

export function isProtonShareUrl(url: string): boolean {
    return /drive\.proton\.me\/urls\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+/.test(url.trim())
}

async function authHeaders(): Promise<Record<string, string>> {
    return {
        'Content-Type': 'application/json',
        'risu-auth': await forageStorage.createAuth(),
    }
}

/** Server errors carry a readable message; anything else is a network failure. */
async function readError(response: Response): Promise<string> {
    try {
        const body = await response.json()
        if (typeof body?.error === 'string') return body.error
    } catch { /* fall through */ }
    return `${response.status}`
}

/** List a share: the file itself, or the folder at `path` (empty = the shared folder). */
export async function inspectProtonShare(url: string, password: string, path: readonly string[] = []): Promise<ProtonInspectResult> {
    const response = await fetch('/api/import/proton/inspect', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ url, password, path }),
    })
    if (!response.ok) throw new Error(await readError(response))
    const info = await response.json()
    return { ...info, trail: info.trail ?? [] }
}

/** The server caps one request at 32 ids. */
const THUMBNAIL_BATCH = 30

/**
 * Previews for files in the folder at `path`, as object URLs keyed by link id.
 * Best effort: whatever fails is simply missing from the result.
 */
export async function fetchProtonThumbnails(
    url: string,
    password: string,
    path: readonly string[],
    linkIds: readonly string[],
    onBatch: (urls: Map<string, string>) => void,
): Promise<void> {
    for (let i = 0; i < linkIds.length; i += THUMBNAIL_BATCH) {
        try {
            const response = await fetch('/api/import/proton/thumbnails', {
                method: 'POST',
                headers: await authHeaders(),
                body: JSON.stringify({ url, password, path, linkIds: linkIds.slice(i, i + THUMBNAIL_BATCH) }),
            })
            if (!response.ok) continue
            const body = await response.json()
            const urls = new Map<string, string>()
            for (const thumbnail of body?.thumbnails ?? []) {
                if (typeof thumbnail?.linkId !== 'string' || typeof thumbnail?.data !== 'string') continue
                const bytes = Uint8Array.from(atob(thumbnail.data), (c) => c.charCodeAt(0))
                urls.set(thumbnail.linkId, URL.createObjectURL(new Blob([bytes], { type: thumbnail.mediaType || 'image/jpeg' })))
            }
            if (urls.size > 0) onBatch(urls)
        } catch {
            // A missing preview only means the row keeps its file-type icon.
        }
    }
}

/**
 * Stream one file so a large bot card reports real progress instead of sitting
 * at zero. Bot archives run to tens of megabytes; the server sends the whole
 * decrypted file, so the transfer is the part worth showing.
 */
export async function downloadProtonEntry(
    url: string,
    password: string,
    target: { linkId?: string; path?: readonly string[]; expectedSize?: number | null },
    report: ImportProgressReporter,
): Promise<{ name: string; data: Uint8Array }> {
    const response = await fetch('/api/import/proton/download', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ url, password, linkId: target.linkId, path: target.path ?? [] }),
    })
    if (!response.ok) throw new Error(await readError(response))

    const header = response.headers.get('x-proton-filename')
    const name = header ? decodeURIComponent(header) : 'proton-download'
    // Fall back to the size the listing reported (Proton quotes the encrypted
    // length, a fraction of a percent above the plaintext) so the bar still
    // moves if the response ends up chunked.
    const declared = Number(response.headers.get('content-length'))
    const expected = target.expectedSize ?? 0
    const total = Number.isFinite(declared) && declared > 0 ? declared : (expected > 0 ? expected : 0)

    // Without a body reader there is nothing to measure — take it in one go.
    if (!response.body) {
        return { name, data: new Uint8Array(await response.arrayBuffer()) }
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        report({
            label: `${language.protonDownloading} ${name}`,
            // Downloading is most of the wait, so it owns 0-80% of the bar.
            // Capped because the fallback total is an estimate and must not
            // let the bar run past the import step that follows.
            progress: total ? Math.min(80, Math.round((received / total) * 80)) : null,
        })
    }

    const data = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
        data.set(chunk, offset)
        offset += chunk.length
    }
    return { name, data }
}
