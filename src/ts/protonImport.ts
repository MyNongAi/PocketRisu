// Import bot files straight from a Proton Drive share link.
//
// The server fetches and decrypts the share (see server/node/proton), so the
// user pastes a link and nothing is ever downloaded by hand. A folder link
// opens PocketRisu's own folder browser rather than Proton's web UI.

import { alertClear, alertError, alertWait, notifySuccess } from './alert'
import { language } from 'src/lang'
import { runImportBatch, type ImportProgressReporter } from './importProgress'
import { downloadProtonEntry, inspectProtonShare, isProtonShareUrl, type ProtonInspectResult } from './protonShareClient'
import { openProtonBrowser, type ProtonPick } from './protonBrowser.svelte'
import { classifySharedImport, type SharedImportKind } from './shareTargetRouting'
import { importCharacterProcess } from './characterCards'
import { importModuleFile } from './process/modules'
import { importPreset } from './storage/database.svelte'

/**
 * Route one decrypted file to whichever importer matches its extension.
 *
 * `report` is passed through, not just for the progress numbers: the character
 * and module importers fall back to their own blocking alerts when no reporter
 * is supplied, which would put a modal back over a background task.
 */
async function importByKind(
    name: string,
    data: Uint8Array,
    report: ImportProgressReporter,
): Promise<SharedImportKind | null> {
    const kind = classifySharedImport(name)
    switch (kind) {
        case 'module':
            await importModuleFile({ name, data }, { suppressSuccess: true, onProgress: report })
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
            await importCharacterProcess({ name, data, suppressSuccess: true, onProgress: report })
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
        info = await inspectProtonShare(url, password)
        alertClear()
    } catch (error) {
        alertClear()
        alertError(`${language.protonImportFailed}\n${error?.message ?? error}`)
        return true
    }

    // A folder always opens the browser, even with a single file in it, so the
    // user sees what is inside (subfolders included) before anything imports.
    let chosen: ProtonPick[]
    if (info.kind === 'folder') {
        const picks = await openProtonBrowser(url, password, info)
        if (!picks || picks.length === 0) return true
        chosen = picks
    } else {
        chosen = info.entries.map((entry) => ({ entry, path: [] }))
    }
    if (chosen.length === 0) {
        alertError(language.protonNoImportableFiles)
        return true
    }

    // From here on the work runs as tracked import tasks: the queue renders its
    // own progress and leaves the app usable, which a modal would not.
    const skipped: string[] = []
    const result = await runImportBatch(
        chosen.map((pick) => ({ name: pick.entry.name, pick })),
        async (item, report) => {
            const file = await downloadProtonEntry(url, password, {
                linkId: info.kind === 'folder' ? item.pick.entry.linkId : undefined,
                path: item.pick.path,
                expectedSize: item.pick.entry.size,
            }, report)
            report({ label: `${language.protonImporting} ${file.name}`, progress: 85 })
            const kind = await importByKind(file.name, file.data, report)
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
