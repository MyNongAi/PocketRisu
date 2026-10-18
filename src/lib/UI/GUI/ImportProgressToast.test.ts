// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { language } from 'src/lang'
import { importTasks, type ImportTaskEntry } from 'src/ts/importProgress'
import ImportProgressToast from './ImportProgressToast.svelte'

const mounted: unknown[] = []
afterEach(async () => {
    await Promise.all(mounted.splice(0).map((component) => unmount(component as never)))
    document.body.replaceChildren()
    importTasks.set(new Map())
    vi.useRealTimers()
})

function show(entry: Partial<ImportTaskEntry>, onMinimize?: () => void, onClose?: () => void) {
    importTasks.set(new Map([['task', {
        id: 'task', fileName: 'huge.charx', kind: 'import', label: 'saving assets', progress: 40, phase: 'running',
        ...entry,
    } as ImportTaskEntry]]))
    const target = document.createElement('div')
    document.body.append(target)
    mounted.push(mount(ImportProgressToast, { target, props: { id: 'task', onMinimize, onClose } }))
    flushSync()
    return target
}

// The x under the "-": it stops a download that can roll back, takes a queued
// one off the queue, and otherwise closes the card (the "-" only folds it).
const cancelButton = (root: HTMLElement) => root.querySelector('button.cancel') as HTMLButtonElement | null
const cancelLabel = (root: HTMLElement) => cancelButton(root)?.getAttribute('aria-label')

describe('import progress card', () => {
    it('cancels only on a second tap, then shows that it is rolling back', () => {
        const cancel = vi.fn()
        const root = show({ cancel })
        expect(cancelLabel(root)).toBe(language.importProgress.cancel)

        cancelButton(root)!.click()
        flushSync()
        expect(cancel).not.toHaveBeenCalled()
        expect(cancelLabel(root)).toBe(language.importProgress.cancelConfirm)
        expect(root.querySelector('.label')?.textContent?.trim()).toBe(language.importProgress.cancelConfirm)

        cancelButton(root)!.click()
        flushSync()
        expect(cancel).toHaveBeenCalledTimes(1)
        // Stopping: the x now only closes the card.
        expect(cancelLabel(root)).toBe(language.importProgress.close)
        expect(root.textContent).toContain(language.importProgress.cancelling)
    })

    it('disarms the cancel button after a few seconds', () => {
        vi.useFakeTimers()
        const cancel = vi.fn()
        const root = show({ cancel })
        cancelButton(root)!.click()
        flushSync()
        vi.advanceTimersByTime(3100)
        flushSync()
        expect(cancelLabel(root)).toBe(language.importProgress.cancel)
        cancelButton(root)!.click()
        flushSync()
        expect(cancel).not.toHaveBeenCalled()
    })

    it('closes the card, without stopping, when the import cannot be cancelled', () => {
        const onClose = vi.fn()
        const root = show({}, undefined, onClose)
        expect(cancelLabel(root)).toBe(language.importProgress.close)
        cancelButton(root)!.click()
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('takes a queued import off the queue with one tap', () => {
        const root = show({ phase: 'queued', label: language.importProgress.queued })
        expect(cancelLabel(root)).toBe(language.importProgress.drop)
        cancelButton(root)!.click()
        flushSync()
        expect(root.textContent).toContain(language.importProgress.dropped)
    })

    it('folds the card with "-", without cancelling', () => {
        const cancel = vi.fn()
        const onMinimize = vi.fn()
        const root = show({ cancel }, onMinimize)
        const minus = root.querySelector('button.minimize') as HTMLButtonElement
        expect(minus.getAttribute('aria-label')).toBe(language.importProgressMinimize)
        minus.click()
        expect(onMinimize).toHaveBeenCalledTimes(1)
        expect(cancel).not.toHaveBeenCalled()
    })

    it('shows the rollback summary on a cancelled card', () => {
        const root = show({
            phase: 'cancelled',
            label: language.importProgress.cancelledRolledBack,
            detail: 'Deleted 12 assets',
            progress: 40,
        })
        expect(root.querySelector('.import-card')?.classList.contains('cancelled')).toBe(true)
        expect(root.textContent).toContain(language.importProgress.cancelledRolledBack)
        expect(root.querySelector('.detail')?.textContent).toBe('Deleted 12 assets')
        expect(cancelLabel(root)).toBe(language.importProgress.close)
    })
})
