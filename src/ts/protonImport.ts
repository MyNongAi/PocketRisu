// Import bot files straight from a Proton Drive share link.
//
// The server fetches and decrypts the share (see server/node/proton), so the
// user pastes a link and nothing is ever downloaded by hand. A folder link
// opens PocketRisu's own folder browser rather than Proton's web UI.

import { alertClear, alertError, alertInput, alertWait, notifySuccess } from './alert'
import { language } from 'src/lang'
import { runPrefetchedImportBatch, type ImportProgressReporter } from './importProgress'
import { downloadProtonEntry, inspectProtonShare, isProtonPasswordRequired, isProtonShareUrl, ProtonRequestError, type ProtonInspectResult } from './protonShareClient'
import { openProtonBrowser, type ProtonPick } from './protonBrowser.svelte'
import { classifySharedImport, type ImportOrigin, type SharedImportKind } from './shareTargetRouting'
import { importCharacterProcess } from './characterCards'
import { importModuleFile, type RisuModule } from './process/modules'
import { getDatabase, importPreset } from './storage/database.svelte'
import { snapshotImportedIds, stampProtonSource, type ProtonSourceRecord } from './protonSource'
import { trackCharacterForSave } from './globalApi.svelte'

// Downloads of a multi-file pick that run at once, and the bytes downloaded
// files may hold before their turn to import (the laptop server keeps a
// whole file in memory per download).
const PROTON_PARALLEL_DOWNLOADS = 3
const PROTON_PREFETCH_BYTES = 256 * 1024 * 1024
const PROTON_UNKNOWN_SIZE_BYTES = 64 * 1024 * 1024

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
    origin: ImportOrigin,
    onModule?: (module: RisuModule) => void,
    source?: ProtonSourceRecord,
): Promise<SharedImportKind | null> {
    if (!source) return importByKindOnly(name, data, report, origin, onModule)
    // What this file adds keeps the link it came from (protonSource.ts).
    const before = snapshotImportedIds(getDatabase())
    const kind = await importByKindOnly(name, data, report, origin, onModule)
    const stamped = stampProtonSource(getDatabase(), before, source)
    for (const chaId of stamped.characters) trackCharacterForSave(chaId)
    return kind
}

async function importByKindOnly(
    name: string,
    data: Uint8Array,
    report: ImportProgressReporter,
    origin: ImportOrigin,
    onModule?: (module: RisuModule) => void,
): Promise<SharedImportKind | null> {
    const kind = classifySharedImport(name, '', origin)
    switch (kind) {
        case 'module': {
            const module = await importModuleFile({ name, data }, { suppressSuccess: true, onProgress: report })
            if (module) onModule?.(module)
            return kind
        }
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

/** Prompts before giving up on a password-protected link. */
const PROTON_PASSWORD_ATTEMPTS = 5

/**
 * Read a share link, asking for the password when its owner set one (the
 * server answers 401) and again when the typed one is refused. Other failures
 * are reported here. Returns null when the user cancels or it cannot be read;
 * otherwise the listing and the password to use for every later call.
 * `subject` heads the prompt when the user did not just paste this link.
 */
export async function openProtonShare(url: string, password = '', subject?: string): Promise<{ info: ProtonInspectResult, password: string } | null> {
    let current = password
    let typed = false
    for (let attempt = 0; attempt <= PROTON_PASSWORD_ATTEMPTS; attempt++) {
        try {
            // Reading the link is a couple of small API calls, so a brief modal
            // is honest here. The transfer itself must not hold the screen.
            alertWait(language.protonInspecting)
            const info = await inspectProtonShare(url, current)
            alertClear()
            return { info, password: current }
        } catch (error) {
            alertClear()
            // Once a password was typed, a refusal from the share most likely
            // means that password was wrong; a network error is still just that.
            const askAgain = isProtonPasswordRequired(error) || (typed && error instanceof ProtonRequestError)
            if (!askAgain || attempt === PROTON_PASSWORD_ATTEMPTS) {
                alertError(`${language.protonImportFailed}\n${error?.message ?? error}`)
                return null
            }
            const prompt = typed ? `${language.protonPasswordWrong}\n(${error?.message ?? error})` : language.protonPasswordPrompt
            const answer = await alertInput(
                subject ? `${subject}\n\n${prompt}` : prompt,
                [],
                '',
                { hideText: true },
            )
            if (!answer) return null
            current = answer
            typed = true
        }
    }
    return null
}

/**
 * Pull one or more files out of a share link.
 *
 * Returns false when the link was not a Proton share, so the caller can fall
 * back to its manual path — Proton has announced a breaking crypto change, and
 * this must degrade to "download it yourself" rather than a dead end.
 *
 * `origin` is the page the link was opened from; a module exported as a
 * .charx is only a module to the module page (see classifySharedImport).
 */
export async function importFromProtonLink(url: string, password = '', origin: ImportOrigin = 'character'): Promise<boolean> {
    if (!isProtonShareUrl(url)) return false

    const opened = await openProtonShare(url, password)
    if (!opened) return true
    await importProtonShare(url, opened.password, opened.info, origin)
    return true
}

/**
 * The part of importFromProtonLink after the link was read: the folder
 * browser for a folder, then the downloads and imports. `onModule` sees every
 * module this imports (the Realm companion download pairs them with its bot).
 */
export async function importProtonShare(
    url: string,
    password: string,
    info: ProtonInspectResult,
    origin: ImportOrigin,
    onModule?: (module: RisuModule) => void,
    options: { browse?: boolean } = {},
): Promise<void> {
    // A folder always opens the browser, even with a single file in it, so the
    // user sees what is inside (subfolders included) before anything imports.
    // `browse` opens it for a single shared file too (a Realm link to a file
    // that is not plainly a module: the user picks it or closes the browser).
    let chosen: ProtonPick[]
    if (info.kind === 'folder' || options.browse) {
        const picks = await openProtonBrowser(url, password, info, origin)
        if (!picks || picks.length === 0) return
        chosen = picks
    } else {
        chosen = info.entries.map((entry) => ({ entry, path: [] }))
    }
    if (chosen.length === 0) {
        alertError(language.protonNoImportableFiles)
        return
    }

    // From here on the work runs as tracked import tasks: the queue renders its
    // own progress and leaves the app usable, which a modal would not.
    // Downloads run ahead of the imports, a few at a time (the server holds a
    // whole file per download); the imports stay one at a time, in order.
    const skipped: string[] = []
    const result = await runPrefetchedImportBatch(
        chosen.map((pick) => ({ name: pick.entry.name, pick })),
        (item, report) => downloadProtonEntry(url, password, {
            linkId: info.kind === 'folder' ? item.pick.entry.linkId : undefined,
            path: item.pick.path,
            expectedSize: item.pick.entry.size,
        }, report),
        async (item, file, report) => {
            report({ label: `${language.protonImporting} ${file.name}`, progress: 85 })
            const kind = await importByKind(file.name, file.data, report, origin, onModule, {
                link: url,
                file: item.pick.entry.name,
                ...(info.kind === 'folder' ? { linkId: item.pick.entry.linkId, path: item.pick.path } : {}),
                at: Date.now(),
            })
            if (!kind) {
                skipped.push(file.name)
                throw new Error(language.protonUnsupportedFile)
            }
        },
        {
            concurrency: PROTON_PARALLEL_DOWNLOADS,
            maxBytes: PROTON_PREFETCH_BYTES,
            sizeOf: (item) => item.pick.entry.size,
            unknownSizeBytes: PROTON_UNKNOWN_SIZE_BYTES,
        },
    )

    if (result.completed > 0) {
        notifySuccess(`${result.completed}/${result.total} ${language.successImport}`)
    }
    if (skipped.length > 0) {
        alertError(`${language.protonUnsupportedFile}\n${skipped.join('\n')}`)
    }
}
