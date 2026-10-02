// A cancellable import that can be taken back.
//
// Used for large CHARX installs (charxPreflight.ts). Every asset write of the
// import is tagged with the transaction id (saveAsset's importScope), so the
// server journals which objects this import created (server/node/
// import-asset-journal.cjs). Cancelling stops further writes, waits for the
// writes already in flight, takes any character/module this import added back
// out of the database, and asks the server to delete the objects that only
// this import created. Assets are content-addressed and shared between bots,
// so the server keeps every object another writer touched or the saved
// database references; the client never names objects to delete.

import { v4 } from 'uuid'
import { language } from 'src/lang'
import type { ImportProgressReporter } from './importProgress'

export type ImportOwner = { type: 'character' | 'module', id: string }

/** What saveAsset and the importers need from a running transaction. */
export interface ImportWriteScope {
    readonly id: string
    /** Throws ImportCancelledError once the import was cancelled. */
    check(): void
    /** Registers an asset write so a rollback waits for it before cleaning up. */
    track<T>(write: Promise<T>): Promise<T>
    /** Records a character/module this import added to the database. */
    registerOwner(type: ImportOwner['type'], id: string): void
}

export interface ImportRollbackSummary {
    /** Characters/modules taken back out of the database. */
    owners: number
    /** Asset objects this import created and nothing else used. */
    removedAssets: number
    /** Asset objects kept: already there before, shared, or still referenced. */
    keptAssets: number
    /** done: the server cleaned up; skipped: it could not track this import; failed: the request failed. */
    assetCleanup: 'done' | 'skipped' | 'failed'
}

export class ImportCancelledError extends Error {
    readonly cancelled = true
    constructor(readonly summary?: ImportRollbackSummary) {
        super(language.importProgress.cancelled)
        this.name = 'ImportCancelledError'
    }
}

export function isImportCancelled(error: unknown): error is ImportCancelledError {
    if (error instanceof ImportCancelledError) return true
    // A CHARX importer that lost several queued saves to the cancel reports
    // them together.
    return error instanceof AggregateError && error.errors.length > 0 && error.errors.every(isImportCancelled)
}

const rollbackSummaries = new WeakMap<object, ImportRollbackSummary>()

/** The rollback that followed a failed (not cancelled) import, if any. */
export function rollbackSummaryOf(error: unknown): ImportRollbackSummary | undefined {
    if (error instanceof ImportCancelledError) return error.summary
    return error && typeof error === 'object' ? rollbackSummaries.get(error) : undefined
}

export class ImportTransaction implements ImportWriteScope {
    readonly id = v4()
    readonly owners: ImportOwner[] = []
    cancelled = false
    private readonly pending = new Set<Promise<unknown>>()

    check(): void {
        if (this.cancelled) throw new ImportCancelledError()
    }

    cancel(): void {
        this.cancelled = true
    }

    track<T>(write: Promise<T>): Promise<T> {
        this.pending.add(write)
        const forget = () => { this.pending.delete(write) }
        write.then(forget, forget)
        return write
    }

    registerOwner(type: ImportOwner['type'], id: string): void {
        this.owners.push({ type, id })
    }

    /** Resolves once no tracked write is in flight, whatever their outcome. */
    async settle(): Promise<void> {
        while (this.pending.size > 0) {
            await Promise.allSettled([...this.pending])
        }
    }
}

interface OwnerDatabase {
    characters: { chaId?: string }[]
    characterOrder?: (string | { data: string[] })[]
    modules: { id: string }[]
    enabledModules?: string[]
}

/**
 * Takes the import's characters and modules back out of the database.
 * Returns how many were removed.
 */
export function removeImportedOwners(db: OwnerDatabase, owners: readonly ImportOwner[]): number {
    const characters = new Set(owners.filter((owner) => owner.type === 'character').map((owner) => owner.id))
    const modules = new Set(owners.filter((owner) => owner.type === 'module').map((owner) => owner.id))
    let removed = 0
    if (characters.size > 0) {
        const before = db.characters.length
        db.characters = db.characters.filter((character) => !characters.has(character.chaId ?? ''))
        removed += before - db.characters.length
        if (db.characterOrder) {
            db.characterOrder = db.characterOrder.flatMap<string | { data: string[] }>((entry) => typeof entry === 'string'
                ? (characters.has(entry) ? [] : [entry])
                : [{ ...entry, data: entry.data.filter((id) => !characters.has(id)) }])
        }
    }
    if (modules.size > 0) {
        const before = db.modules.length
        db.modules = db.modules.filter((module) => !modules.has(module.id))
        removed += before - db.modules.length
        if (db.enabledModules) db.enabledModules = db.enabledModules.filter((id) => !modules.has(id))
    }
    return removed
}

export interface ImportTransactionDeps {
    /** Opens the server journal; false when the server cannot track this import. */
    begin(id: string): Promise<boolean>
    /** Closes the journal of a finished import (nothing is deleted). */
    commit(id: string): Promise<void>
    /** Server rollback: deletes what only this import created. tracked is false when the server had lost the journal. */
    rollbackAssets(id: string): Promise<{ removed: number, kept: number, tracked?: boolean }>
    /** Removes owners from the live database; returns how many were removed. */
    removeOwners(owners: readonly ImportOwner[]): number
    /** Waits until the database reached the server; false when it did not. */
    persist(): Promise<boolean>
}

async function loadDefaultDeps(): Promise<ImportTransactionDeps> {
    const { forageStorage, flushSaves, checkCharOrder } = await import('./globalApi.svelte')
    const { getDatabase } = await import('./storage/database.svelte')
    return {
        begin: (id) => forageStorage.beginImportJournal(id),
        commit: (id) => forageStorage.commitImportJournal(id),
        rollbackAssets: (id) => forageStorage.rollbackImportJournal(id),
        removeOwners: (owners) => {
            const removed = removeImportedOwners(getDatabase() as unknown as OwnerDatabase, owners)
            if (removed > 0) checkCharOrder()
            return removed
        },
        persist: () => flushSaves(),
    }
}

async function rollback(
    transaction: ImportTransaction,
    journaled: boolean,
    deps: ImportTransactionDeps,
): Promise<ImportRollbackSummary> {
    await transaction.settle()
    const owners = deps.removeOwners(transaction.owners)
    // The server keeps every asset the saved database still references, so a
    // save that does not arrive only leaves assets behind; it never loses any.
    if (owners > 0) await deps.persist().catch(() => false)
    if (!journaled) return { owners, removedAssets: 0, keptAssets: 0, assetCleanup: 'skipped' }
    try {
        const result = await deps.rollbackAssets(transaction.id)
        if (result.tracked === false) return { owners, removedAssets: 0, keptAssets: 0, assetCleanup: 'skipped' }
        return { owners, removedAssets: result.removed, keptAssets: result.kept, assetCleanup: 'done' }
    } catch (error) {
        console.warn('[Import] asset rollback failed; assets stay in place', error)
        return { owners, removedAssets: 0, keptAssets: 0, assetCleanup: 'failed' }
    }
}

/**
 * Runs `work` as a cancellable transaction. The task card offers a cancel
 * action while it runs. A cancel, or a failure, rolls back and rethrows: a
 * cancel as ImportCancelledError carrying the summary, a failure as itself
 * (rollbackSummaryOf finds the summary).
 */
export async function runImportTransaction<T>(
    report: ImportProgressReporter | undefined,
    work: (transaction: ImportTransaction) => Promise<T>,
    deps?: ImportTransactionDeps,
): Promise<T> {
    const resolved = deps ?? await loadDefaultDeps()
    const transaction = new ImportTransaction()
    let journaled = false
    try {
        journaled = await resolved.begin(transaction.id)
    } catch (error) {
        console.warn('[Import] server journal unavailable; a cancel cannot remove assets', error)
    }
    report?.cancellable?.(() => transaction.cancel())
    try {
        const result = await work(transaction)
        // A cancel that arrived while the last step finished still rolls back.
        transaction.check()
        report?.cancellable?.(null)
        if (journaled) await resolved.commit(transaction.id).catch(() => {})
        return result
    } catch (error) {
        const cancelled = transaction.cancelled || isImportCancelled(error)
        transaction.cancel()
        report?.cancellable?.(null)
        if (!cancelled) report?.({ label: language.importProgress.rollingBack, progress: null })
        const summary = await rollback(transaction, journaled, resolved)
        if (cancelled) throw new ImportCancelledError(summary)
        if (error && typeof error === 'object') rollbackSummaries.set(error, summary)
        throw error
    }
}

/** One line for the progress card. */
export function describeImportRollback(summary: ImportRollbackSummary): string {
    const text = language.importProgress
    const parts: string[] = []
    if (summary.owners > 0) parts.push(text.rollbackOwners)
    if (summary.assetCleanup === 'done') {
        parts.push(text.rollbackAssets(summary.removedAssets, summary.keptAssets))
    } else if (summary.assetCleanup === 'failed') {
        parts.push(text.rollbackAssetsFailed)
    } else {
        parts.push(text.rollbackAssetsUntracked)
    }
    return parts.join(' ')
}
