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

function show(entry: Partial<ImportTaskEntry>) {
    importTasks.set(new Map([['task', {
        id: 'task', fileName: 'huge.charx', kind: 'import', label: 'saving assets', progress: 40, phase: 'running',
        ...entry,
    } as ImportTaskEntry]]))
    const target = document.createElement('div')
    document.body.append(target)
    mounted.push(mount(ImportProgressToast, { target, props: { id: 'task' } }))
    flushSync()
    return target
}

const cancelButton = (root: HTMLElement) => root.querySelector('button.cancel') as HTMLButtonElement | null

describe('import progress card', () => {
    it('cancels only on a second tap, then shows that it is rolling back', () => {
        const cancel = vi.fn()
        const root = show({ cancel })
        expect(cancelButton(root)?.textContent?.trim()).toBe(language.importProgress.cancel)

        cancelButton(root)!.click()
        flushSync()
        expect(cancel).not.toHaveBeenCalled()
        expect(cancelButton(root)?.textContent?.trim()).toBe(language.importProgress.cancelConfirm)

        cancelButton(root)!.click()
        flushSync()
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(cancelButton(root)).toBeNull()
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
        expect(cancelButton(root)?.textContent?.trim()).toBe(language.importProgress.cancel)
        cancelButton(root)!.click()
        flushSync()
        expect(cancel).not.toHaveBeenCalled()
    })

    it('has no cancel button for imports that cannot be cancelled', () => {
        expect(cancelButton(show({}))).toBeNull()
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
        expect(cancelButton(root)).toBeNull()
    })
})
