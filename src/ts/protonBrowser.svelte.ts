// State and pure helpers for the Proton folder browser
// (src/lib/Others/ProtonFolderBrowser.svelte).
//
// The importer opens the browser with the first listing and awaits the user's
// picks; the component mounted in App.svelte does the rest.

import { classifySharedImport, type ImportOrigin, type SharedImportKind } from './shareTargetRouting'
import type { ProtonEntry, ProtonInspectResult } from './protonShareClient'

/** One file the user chose, with the folders it sits in (outermost first). */
export interface ProtonPick {
    entry: ProtonEntry
    path: string[]
}

export type ProtonRowKind = 'folder' | SharedImportKind | 'unsupported'

export interface ProtonRow {
    entry: ProtonEntry
    kind: ProtonRowKind
    /** Files PocketRisu knows how to import; folders are opened, not picked. */
    importable: boolean
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Folders first, then files, each in natural order ("2" before "10"). */
export function buildProtonRows(entries: readonly ProtonEntry[], origin: ImportOrigin = 'character'): ProtonRow[] {
    const rows = entries.map((entry): ProtonRow => {
        if (entry.type === 1) return { entry, kind: 'folder', importable: false }
        const kind = classifySharedImport(entry.name, entry.mediaType ?? '', origin)
        return kind ? { entry, kind, importable: true } : { entry, kind: 'unsupported', importable: false }
    })
    return rows.sort((a, b) => {
        const folderOrder = Number(b.kind === 'folder') - Number(a.kind === 'folder')
        return folderOrder || collator.compare(a.entry.name, b.entry.name)
    })
}

export function formatProtonSize(bytes: number | null | undefined): string {
    if (!bytes || bytes < 0) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const protonBrowserState = $state<{
    open: boolean
    url: string
    password: string
    initial: ProtonInspectResult | null
    origin: ImportOrigin
}>({
    open: false,
    url: '',
    password: '',
    initial: null,
    origin: 'character',
})

let resolvePicks: ((picks: ProtonPick[] | null) => void) | null = null

/** Show the browser on `initial` and resolve with the chosen files, or null on cancel. */
export function openProtonBrowser(
    url: string,
    password: string,
    initial: ProtonInspectResult,
    origin: ImportOrigin = 'character',
): Promise<ProtonPick[] | null> {
    // A browser that is already open gets cancelled rather than orphaned.
    resolvePicks?.(null)
    protonBrowserState.url = url
    protonBrowserState.password = password
    protonBrowserState.initial = initial
    protonBrowserState.origin = origin
    protonBrowserState.open = true
    return new Promise((resolve) => {
        resolvePicks = resolve
    })
}

export function closeProtonBrowser(picks: ProtonPick[] | null): void {
    const resolve = resolvePicks
    resolvePicks = null
    protonBrowserState.open = false
    protonBrowserState.initial = null
    protonBrowserState.url = ''
    protonBrowserState.password = ''
    resolve?.(picks)
}
