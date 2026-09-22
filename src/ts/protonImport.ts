// Import bot files straight from a Proton Drive share link.
//
// The server fetches and decrypts the share (see server/node/proton), so the
// user pastes a link and nothing is ever downloaded by hand. A folder link is
// listed in PocketRisu's own picker rather than sending the user to Proton's
// web UI.

import { alertClear, alertError, alertSelect, alertWait, notifySuccess } from './alert'
import { language } from 'src/lang'
import { forageStorage } from './globalApi.svelte'
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

async function downloadEntry(url: string, password: string, linkId?: string) {
    const response = await fetch('/api/import/proton/download', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ url, password, linkId }),
    })
    if (!response.ok) throw new Error(await readError(response))
    const header = response.headers.get('x-proton-filename')
    return {
        name: header ? decodeURIComponent(header) : 'proton-download',
        data: new Uint8Array(await response.arrayBuffer()),
    }
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

    try {
        alertWait(language.protonInspecting)
        const info = await inspectShare(url, password)

        // Only files can be imported; a nested folder is not descended into.
        const files = info.entries.filter(entry => entry.type !== 1)
        if (files.length === 0) {
            alertError(language.protonNoImportableFiles)
            return true
        }

        let chosen = files
        if (info.kind === 'folder' && files.length > 1) {
            alertClear()
            const labels = files.map(entry => `${entry.name}${entry.size ? ` (${formatSize(entry.size)})` : ''}`)
            const picked = await alertSelect([...labels, language.protonImportAll])
            const index = Number(picked)
            if (!Number.isFinite(index) || index < 0) return true
            chosen = index >= files.length ? files : [files[index]]
        }

        let imported = 0
        const skipped: string[] = []
        for (const entry of chosen) {
            alertWait(`${language.protonImporting} ${entry.name}`)
            const file = await downloadEntry(url, password, info.kind === 'folder' ? entry.linkId : undefined)
            const kind = await importByKind(file.name, file.data)
            if (kind) imported++
            else skipped.push(file.name)
        }

        alertClear()
        if (imported > 0) {
            notifySuccess(`${imported}/${chosen.length} ${language.successImport}`)
        }
        if (skipped.length > 0) {
            alertError(`${language.protonUnsupportedFile}\n${skipped.join('\n')}`)
        }
        return true
    } catch (error) {
        alertClear()
        alertError(`${language.protonImportFailed}\n${error?.message ?? error}`)
        return true
    }
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
