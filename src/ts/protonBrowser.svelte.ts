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

function compareProtonRowsByName(a: ProtonRow, b: ProtonRow): number {
    const folderOrder = Number(b.kind === 'folder') - Number(a.kind === 'folder')
    return folderOrder || collator.compare(a.entry.name, b.entry.name)
}

/** Folders first, then files, each in natural order ("2" before "10"). */
export function buildProtonRows(entries: readonly ProtonEntry[], origin: ImportOrigin = 'character'): ProtonRow[] {
    const rows = entries.map((entry): ProtonRow => {
        if (entry.type === 1) return { entry, kind: 'folder', importable: false }
        const kind = classifySharedImport(entry.name, entry.mediaType ?? '', origin)
        // No plugins here: the plugin page's Proton button installs them, with
        // its warning (protonImport.ts, 2026-11-08).
        return kind && kind !== 'plugin' ? { entry, kind, importable: true } : { entry, kind: 'unsupported', importable: false }
    })
    return rows.sort(compareProtonRowsByName)
}

/** Filter this folder without changing the rows or the user's picks. */
export function filterProtonRows(
    rows: readonly ProtonRow[],
    { query, onlyImportable, newestFirst }: { query: string; onlyImportable: boolean; newestFirst: boolean },
): { visible: ProtonRow[]; hiddenCount: number } {
    const search = query.trim().toLowerCase()
    const hiddenCount = onlyImportable ? rows.filter((row) => row.kind !== 'folder' && !row.importable).length : 0
    const visible = rows.filter((row) =>
        (!onlyImportable || row.kind === 'folder' || row.importable)
        && (!search || row.entry.name.toLowerCase().includes(search)))
    visible.sort((a, b) => {
        const folderOrder = Number(b.kind === 'folder') - Number(a.kind === 'folder')
        const timeOrder = newestFirst ? modificationTime(b.entry.modifiedAt) - modificationTime(a.entry.modifiedAt) : 0
        return folderOrder || timeOrder || compareProtonRowsByName(a, b)
    })
    return { visible, hiddenCount }
}

function modificationTime(ms: number | null | undefined): number {
    return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0
}

/** The local YYYY-MM-DD format used by the upstream Proton import dialog. */
export function formatProtonDate(ms: number | null | undefined): string {
    const time = modificationTime(ms)
    if (!time) return ''
    const date = new Date(time)
    if (Number.isNaN(date.getTime())) return ''
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
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

/**
 * The files chosen, and what the user imports them as: the browser has a
 * bot and a module button (the user's request, 2026-11-08), and a .charx or
 * .json is read as that. A file only one importer takes (.risum, an image
 * card, a preset, a plugin) keeps its own kind (classifySharedImport).
 */
export interface ProtonBrowserChoice {
    picks: ProtonPick[]
    as: ImportOrigin
}

let resolvePicks: ((choice: ProtonBrowserChoice | null) => void) | null = null

/** Show the browser on `initial` and resolve with the chosen files, or null on cancel. */
export function openProtonBrowser(
    url: string,
    password: string,
    initial: ProtonInspectResult,
    origin: ImportOrigin = 'character',
): Promise<ProtonBrowserChoice | null> {
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

/** `as`: the import button pressed; without one, the page the browser was opened from. */
export function closeProtonBrowser(picks: ProtonPick[] | null, as: ImportOrigin = protonBrowserState.origin): void {
    const resolve = resolvePicks
    resolvePicks = null
    protonBrowserState.open = false
    protonBrowserState.initial = null
    protonBrowserState.url = ''
    protonBrowserState.password = ''
    resolve?.(picks ? { picks, as } : null)
}
