import { writable } from 'svelte/store'
import { language } from 'src/lang'

export type ImportTaskPhase = 'queued' | 'running' | 'done' | 'failed'

export interface ImportProgressUpdate {
    label: string
    progress?: number | null
}

export type ImportProgressReporter = (update: ImportProgressUpdate) => void

export interface ImportTaskEntry {
    id: string
    fileName: string
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

export function createImportTask(fileName: string): string {
    const id = `import-${Date.now()}-${++taskSerial}`
    importTasks.update((current) => {
        const next = new Map(current)
        next.set(id, {
            id,
            fileName,
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
        label: language.importProgress.importing,
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
