import { describe, expect, it, vi } from 'vitest'
import {
    ImportCancelledError,
    ImportTransaction,
    describeImportRollback,
    isImportCancelled,
    removeImportedOwners,
    rollbackSummaryOf,
    runImportTransaction,
    type ImportTransactionDeps,
} from './importTransaction'
import type { ImportProgressReporter } from './importProgress'

function deps(overrides: Partial<ImportTransactionDeps> = {}) {
    const events: string[] = []
    const value: ImportTransactionDeps = {
        begin: vi.fn(async () => { events.push('begin'); return true }),
        commit: vi.fn(async () => { events.push('commit') }),
        rollbackAssets: vi.fn(async () => { events.push('rollback-assets'); return { removed: 3, kept: 2 } }),
        removeOwners: vi.fn((owners) => { events.push(`remove-owners:${owners.length}`); return owners.length }),
        persist: vi.fn(async () => { events.push('persist'); return true }),
        ...overrides,
    }
    return { deps: value, events }
}

function reporter() {
    let cancel: (() => void) | null = null
    const report = vi.fn() as unknown as ImportProgressReporter & ReturnType<typeof vi.fn>
    report.cancellable = (handler) => { cancel = handler }
    return { report, cancel: () => cancel }
}

describe('import transaction', () => {
    it('refuses work after cancel and waits for writes already in flight', async () => {
        const transaction = new ImportTransaction()
        let finish!: () => void
        const write = transaction.track(new Promise<void>((resolve) => { finish = resolve }))
        transaction.cancel()
        expect(() => transaction.check()).toThrow(ImportCancelledError)

        let settled = false
        const settling = transaction.settle().then(() => { settled = true })
        await Promise.resolve()
        expect(settled).toBe(false)
        finish()
        await write
        await settling
        expect(settled).toBe(true)
    })

    it('treats a batch of cancelled saves as a cancel', () => {
        expect(isImportCancelled(new ImportCancelledError())).toBe(true)
        expect(isImportCancelled(new AggregateError([new ImportCancelledError(), new ImportCancelledError()]))).toBe(true)
        expect(isImportCancelled(new AggregateError([new ImportCancelledError(), new Error('disk full')]))).toBe(false)
        expect(isImportCancelled(new Error('x'))).toBe(false)
    })

    it('commits a finished import and offers cancel only while it runs', async () => {
        const { deps: d, events } = deps()
        const { report, cancel } = reporter()
        const result = await runImportTransaction(report, async (transaction) => {
            expect(cancel()).toBeTypeOf('function')
            transaction.registerOwner('character', 'new-bot')
            return 7
        }, d)
        expect(result).toBe(7)
        expect(cancel()).toBeNull()
        expect(events).toEqual(['begin', 'commit'])
        expect(d.removeOwners).not.toHaveBeenCalled()
    })

    it('rolls back after a cancel: waits for writes, removes owners, saves, then cleans assets', async () => {
        const { deps: d, events } = deps()
        const { report, cancel } = reporter()
        let finishWrite!: () => void
        const running = runImportTransaction(report, async (transaction) => {
            transaction.registerOwner('module', 'new-module')
            void transaction.track(new Promise<void>((resolve) => {
                finishWrite = () => { events.push('write-done'); resolve() }
            }))
            await new Promise((resolve) => setTimeout(resolve, 0))
            transaction.check()
            return 'not reached'
        }, d)
        // The work is now waiting on its timer, with one write in flight.
        await new Promise((resolve) => setTimeout(resolve, 0))
        cancel()!()
        await new Promise((resolve) => setTimeout(resolve, 5))
        expect(d.rollbackAssets).not.toHaveBeenCalled()
        finishWrite()

        const error = await running.catch((caught) => caught)
        expect(isImportCancelled(error)).toBe(true)
        expect(error.summary).toEqual({ owners: 1, removedAssets: 3, keptAssets: 2, assetCleanup: 'done' })
        expect(events).toEqual(['begin', 'write-done', 'remove-owners:1', 'persist', 'rollback-assets'])
        expect(d.commit).not.toHaveBeenCalled()
    })

    it('a cancel that lands as the last step finishes still rolls back', async () => {
        const { deps: d } = deps()
        const { report, cancel } = reporter()
        const error = await runImportTransaction(report, async (transaction) => {
            transaction.registerOwner('character', 'bot')
            cancel()!()
            return 1
        }, d).catch((caught) => caught)
        expect(isImportCancelled(error)).toBe(true)
        expect(d.removeOwners).toHaveBeenCalledWith([{ type: 'character', id: 'bot' }])
    })

    it('rolls back a failed import too, and keeps its error', async () => {
        const { deps: d } = deps()
        const failure = new Error('disk full')
        const error = await runImportTransaction(undefined, async () => { throw failure }, d).catch((caught) => caught)
        expect(error).toBe(failure)
        expect(rollbackSummaryOf(error)).toEqual({ owners: 0, removedAssets: 3, keptAssets: 2, assetCleanup: 'done' })
        // Nothing to take out of the database: no save is waited for.
        expect(d.persist).not.toHaveBeenCalled()
    })

    it('reports untracked and failed asset cleanup without deleting on the client', async () => {
        const untracked = deps({ begin: vi.fn(async () => false) })
        const first = await runImportTransaction(undefined, async (transaction) => {
            transaction.cancel()
            transaction.check()
        }, untracked.deps).catch((caught) => caught)
        expect(first.summary.assetCleanup).toBe('skipped')
        expect(untracked.deps.rollbackAssets).not.toHaveBeenCalled()

        const lost = deps({ rollbackAssets: vi.fn(async () => ({ removed: 0, kept: 0, tracked: false })) })
        const second = await runImportTransaction(undefined, async (transaction) => {
            transaction.cancel()
            transaction.check()
        }, lost.deps).catch((caught) => caught)
        expect(second.summary.assetCleanup).toBe('skipped')

        const offline = deps({ rollbackAssets: vi.fn(async () => { throw new Error('offline') }) })
        const third = await runImportTransaction(undefined, async (transaction) => {
            transaction.cancel()
            transaction.check()
        }, offline.deps).catch((caught) => caught)
        expect(third.summary).toEqual({ owners: 0, removedAssets: 0, keptAssets: 0, assetCleanup: 'failed' })
    })

    it('describes the rollback in one line', () => {
        expect(describeImportRollback({ owners: 0, removedAssets: 12, keptAssets: 4, assetCleanup: 'done' }))
            .toMatch(/12.*4/)
        expect(describeImportRollback({ owners: 1, removedAssets: 0, keptAssets: 0, assetCleanup: 'failed' }))
            .not.toBe('')
    })
})

describe('removing imported owners', () => {
    it('takes out only the import\'s characters and modules, with their order entries', () => {
        const db = {
            characters: [{ chaId: 'old' }, { chaId: 'new' }],
            characterOrder: ['old', 'new', { id: 'folder', data: ['new', 'other'] }],
            modules: [{ id: 'kept-module' }, { id: 'new-module' }],
            enabledModules: ['kept-module', 'new-module'],
        }
        const removed = removeImportedOwners(db, [
            { type: 'character', id: 'new' },
            { type: 'module', id: 'new-module' },
            { type: 'module', id: 'never-added' },
        ])
        expect(removed).toBe(2)
        expect(db.characters).toEqual([{ chaId: 'old' }])
        expect(db.characterOrder).toEqual(['old', { id: 'folder', data: ['other'] }])
        expect(db.modules).toEqual([{ id: 'kept-module' }])
        expect(db.enabledModules).toEqual(['kept-module'])
    })
})
