// Import bot files straight from a Proton Drive share link.
//
// The server fetches and decrypts the share (see server/node/proton), so the
// user pastes a link and nothing is ever downloaded by hand. A folder link is
// listed in PocketRisu's own picker rather than sending the user to Proton's
// web UI.

import { alertClear, alertError, alertSelect, alertWait, notifySuccess } from './alert'
import { language } from 'src/lang'
import { forageStorage } from './globalApi.svelte'
import { runImportBatch, type ImportProgressReporter } from './importProgress'
import { classifySharedImport, type SharedImportKind } from './shareTargetRouting'
import { importCharacterProcess } from './characterCards'
import { importModuleFile } from './process/modules'
import { importPreset } from './storage/database.svelte'

interface ProtonEntry {
    name: string
    linkId: string
    /** 1 = folder, 2 = file */
    type: number
    size: number | null
    mediaType: string | null
}

interface ProtonInspectResult {
    kind: 'file' | 'folder'
    name: string
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

async function inspectShare(url: string, password: string): Promise<ProtonInspectResult> {
    const response = await fetch('/api/import/proton/inspect', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ url, password }),
    })
    if (!response.ok) throw new Error(await readError(response))
    return await response.json()
}

/**
 * Stream the file so a large bot card reports real progress instead of sitting
 * at zero. Bot archives run to tens of megabytes; the server sends the whole
 * decrypted file, so the transfer is the part worth showing.
 */
async function downloadEntry(
    url: string,
    password: string,
    linkId: string | undefined,
    report: ImportProgressReporter,
    expectedSize: number | null,
) {
    const response = await fetch('/api/import/proton/download', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ url, password, linkId }),
    })
    if (!response.ok) throw new Error(await readError(response))

    const header = response.headers.get('x-proton-filename')
    const name = header ? decodeURIComponent(header) : 'proton-download'
    // Fall back to the size the listing reported (Proton quotes the encrypted
    // length, a fraction of a percent above the plaintext) so the bar still
    // moves if the response ends up chunked.
    const declared = Number(response.headers.get('content-length'))
    const total = Number.isFinite(declared) && declared > 0
        ? declared
        : (expectedSize && expectedSize > 0 ? expectedSize : 0)

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

/** Route one decrypted file to whichever importer matches its extension. */
async function importByKind(name: string, data: Uint8Array): Promise<SharedImportKind | null> {
    const kind = classifySharedImport(name)
    switch (kind) {
        case 'module':
            await importModuleFile({ name, data }, { suppressSuccess: true })
            return kind
        case 'preset':
            await importPreset({ name, data })
            return kind
        case 'plugin': {
            const { importPlugin } = await import('./plugins/plugins.svelte')
            await importPlugin(
                Buffer.from(data).toString('utf-8').replace(/^﻿/, ''),
                { isTypescript: name.toLowerCase().endsWith('.ts') },
            )
            return kind
        }
        case 'character':
            await importCharacterProcess({ name, data, suppressSuccess: true })
            return kind
        default:
            return null
    }
}

/**
 * Pull one or more files out of a share link.
 *
 * Returns false when the link was not a Proton share, so the caller can fall
 * back to its manual path — Proton has announced a breaking crypto change, and
 * this must degrade to "download it yourself" rather than a dead end.
 */
export async function importFromProtonLink(url: string, password = ''): Promise<boolean> {
    if (!isProtonShareUrl(url)) return false

    let info: ProtonInspectResult
    try {
        // Reading the link is a couple of small API calls, so a brief modal is
        // honest here. The transfer itself must not hold the screen.
        alertWait(language.protonInspecting)
        info = await inspectShare(url, password)
        alertClear()
    } catch (error) {
        alertClear()
        alertError(`${language.protonImportFailed}\n${error?.message ?? error}`)
        return true
    }

    // Only files can be imported; a nested folder is not descended into.
    const files = info.entries.filter(entry => entry.type !== 1)
    if (files.length === 0) {
        alertError(language.protonNoImportableFiles)
        return true
    }

    let chosen = files
    if (info.kind === 'folder' && files.length > 1) {
        const labels = files.map(entry => `${entry.name}${entry.size ? ` (${formatSize(entry.size)})` : ''}`)
        const picked = await alertSelect([...labels, language.protonImportAll])
        const index = Number(picked)
        if (!Number.isFinite(index) || index < 0) return true
        chosen = index >= files.length ? files : [files[index]]
    }

    // From here on the work runs as tracked import tasks: the queue renders its
    // own progress and leaves the app usable, which a modal would not.
    const skipped: string[] = []
    const result = await runImportBatch(
        chosen.map(entry => ({ name: entry.name, entry })),
        async (item, report) => {
            const file = await downloadEntry(
                url,
                password,
                info.kind === 'folder' ? item.entry.linkId : undefined,
                report,
                item.entry.size,
            )
            report({ label: `${language.protonImporting} ${file.name}`, progress: 85 })
            const kind = await importByKind(file.name, file.data)
            if (!kind) {
                skipped.push(file.name)
                throw new Error(language.protonUnsupportedFile)
            }
        },
    )

    if (result.completed > 0) {
        notifySuccess(`${result.completed}/${result.total} ${language.successImport}`)
    }
    if (skipped.length > 0) {
        alertError(`${language.protonUnsupportedFile}\n${skipped.join('\n')}`)
    }
    return true
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
