import { writable } from 'svelte/store'
import { language } from 'src/lang'

export type ImportTaskPhase = 'queued' | 'running' | 'done' | 'failed'

/** Imports and exports share one progress surface; the kind only picks the labels. */
export type ImportTaskKind = 'import' | 'export'

export interface ImportProgressUpdate {
    label: string
    progress?: number | null
}

export type ImportProgressReporter = (update: ImportProgressUpdate) => void

export interface ImportTaskEntry {
    id: string
    fileName: string
    kind: ImportTaskKind
    label: string
    progress: number | null
    phase: ImportTaskPhase
    startedAt?: number
    endedAt?: number
    error?: string
}

export interface ImportBatchResult {
    completed: number
    failed: number
    total: number
}

export const importTasks = writable<Map<string, ImportTaskEntry>>(new Map())

let taskSerial = 0

function updateTask(id: string, update: (entry: ImportTaskEntry) => ImportTaskEntry): void {
    importTasks.update((current) => {
        const entry = current.get(id)
        if (!entry) return current
        const next = new Map(current)
        next.set(id, update(entry))
        return next
    })
}

function clampProgress(progress: number | null | undefined): number | null {
    if (progress === null || progress === undefined || !Number.isFinite(progress)) return null
    return Math.min(100, Math.max(0, progress))
}

export function createImportTask(fileName: string, kind: ImportTaskKind = 'import'): string {
    const id = `import-${Date.now()}-${++taskSerial}`
    importTasks.update((current) => {
        const next = new Map(current)
        next.set(id, {
            id,
            fileName,
            kind,
            label: language.importProgress.queued,
            progress: 0,
            phase: 'queued',
        })
        return next
    })
    return id
}

export function startImportTask(id: string): void {
    updateTask(id, (entry) => ({
        ...entry,
        label: entry.kind === 'export' ? language.exportProgress.exporting : language.importProgress.importing,
        phase: 'running',
        startedAt: Date.now(),
    }))
}

export function reportImportTask(id: string, update: ImportProgressUpdate): void {
    updateTask(id, (entry) => {
        if (entry.phase === 'done' || entry.phase === 'failed') return entry
        return {
            ...entry,
            label: update.label,
            progress: clampProgress(update.progress),
        }
    })
}

export function completeImportTask(id: string): void {
    updateTask(id, (entry) => ({
        ...entry,
        label: language.importProgress.done,
        progress: 100,
        phase: 'done',
        endedAt: Date.now(),
    }))
}

export function failImportTask(id: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    updateTask(id, (entry) => ({
        ...entry,
        label: language.importProgress.failed,
        phase: 'failed',
        endedAt: Date.now(),
        error: message,
    }))
}

export function clearImportTask(id: string): void {
    importTasks.update((current) => {
        if (!current.has(id)) return current
        const next = new Map(current)
        next.delete(id)
        return next
    })
}

/**
 * Runs one import through the same non-blocking progress surface used by file
 * batches. This is useful for imports whose source is not a local File, such
 * as a Realm download.
 */
export async function runImportTask<T>(
    fileName: string,
    importer: (report: ImportProgressReporter) => Promise<T>,
): Promise<T> {
    const id = createImportTask(fileName)
    startImportTask(id)
    try {
        const value = await importer((update) => reportImportTask(id, update))
        completeImportTask(id)
        return value
    } catch (error) {
        failImportTask(id, error)
        throw error
    }
}

/**
 * Adapts the `(message, percent)` callbacks that the card and module exporters
 * accept to a task reporter, so an export shows up in the same toast as imports.
 */
export function adaptLegacyProgress(report: ImportProgressReporter): (msg: string, pct: number) => void {
    return (msg, pct) => report({ label: msg, progress: pct })
}

/**
 * Runs one export without a blocking modal. Exporters that swallow their own
 * errors still resolve, so the task completes; a thrown error marks it failed.
 */
export async function runExportTask<T>(
    fileName: string,
    exporter: (report: ImportProgressReporter) => Promise<T>,
): Promise<T> {
    const id = createImportTask(fileName, 'export')
    startImportTask(id)
    try {
        const value = await exporter((update) => reportImportTask(id, update))
        completeImportTask(id)
        return value
    } catch (error) {
        failImportTask(id, error)
        throw error
    }
}

/**
 * Creates every visible task up front, then imports sequentially. Users see
 * the whole queue immediately while database and asset writes remain ordered.
 */
export async function runImportBatch<T extends { name: string }>(
    files: readonly T[],
    importer: (file: T, report: ImportProgressReporter) => Promise<void>,
): Promise<ImportBatchResult> {
    const entries = files.map((file) => ({ file, id: createImportTask(file.name) }))
    let completed = 0
    let failed = 0

    for (const { file, id } of entries) {
        startImportTask(id)
        try {
            await importer(file, (update) => reportImportTask(id, update))
            completeImportTask(id)
            completed++
        } catch (error) {
            failImportTask(id, error)
            failed++
        }
    }

    return { completed, failed, total: entries.length }
}

export interface PrefetchLimits<T> {
    /** Fetches running at once. */
    concurrency: number
    /** Bytes fetched items may hold until their import ends (one larger item still runs, alone). */
    maxBytes: number
    /** An item's size in bytes, or null/undefined when unknown. */
    sizeOf: (item: T) => number | null | undefined
    /** What an item of unknown size counts for. */
    unknownSizeBytes: number
}

/**
 * runImportBatch with a fetch step that runs ahead: up to `concurrency`
 * fetches at once (a queued task shows its fetch progress), while the
 * imports stay one at a time in list order, so database and asset writes
 * stay ordered. A fetched item holds its bytes until its import ends; the
 * next fetch starts only while the held total stays within `maxBytes`.
 */
export async function runPrefetchedImportBatch<T extends { name: string }, F>(
    items: readonly T[],
    fetchItem: (item: T, report: ImportProgressReporter) => Promise<F>,
    importItem: (item: T, fetched: F, report: ImportProgressReporter) => Promise<void>,
    limits: PrefetchLimits<T>,
): Promise<ImportBatchResult> {
    const entries = items.map((item) => ({
        item,
        id: createImportTask(item.name),
        bytes: Math.max(0, limits.sizeOf(item) ?? limits.unknownSizeBytes),
        fetched: null as Promise<F> | null,
        held: false,
    }))
    let running = 0
    let heldBytes = 0
    let next = 0

    const release = (entry: typeof entries[number]) => {
        if (!entry.held) return
        entry.held = false
        heldBytes -= entry.bytes
        pump()
    }
    const start = (entry: typeof entries[number]) => {
        running++
        entry.held = true
        heldBytes += entry.bytes
        entry.fetched = fetchItem(entry.item, (update) => reportImportTask(entry.id, update))
        entry.fetched.then(
            () => { running--; pump() },
            // A failed fetch holds nothing; its import reports the error.
            () => { running--; release(entry) },
        )
    }
    function pump() {
        while (next < entries.length && running < limits.concurrency) {
            const entry = entries[next]
            if (heldBytes > 0 && heldBytes + entry.bytes > limits.maxBytes) return
            next++
            start(entry)
        }
    }

    pump()
    let completed = 0
    let failed = 0
    for (const entry of entries) {
        // Everything before this entry is released, so it has started (the
        // fallback only guards the invariant).
        if (!entry.fetched) {
            next = Math.max(next, entries.indexOf(entry) + 1)
            start(entry)
        }
        startImportTask(entry.id)
        try {
            const fetched = await entry.fetched!
            await importItem(entry.item, fetched, (update) => reportImportTask(entry.id, update))
            completeImportTask(entry.id)
            completed++
        } catch (error) {
            failImportTask(entry.id, error)
            failed++
        } finally {
            release(entry)
        }
    }

    return { completed, failed, total: entries.length }
}
