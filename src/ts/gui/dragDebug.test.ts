import { afterEach, describe, expect, it, vi } from 'vitest'

async function load() {
    vi.resetModules()
    return await import('./dragDebug')
}

function folderList(folderId: string, group: string) {
    const holder = document.createElement('div')
    holder.setAttribute('data-folder-container', folderId)
    const list = document.createElement('div')
    list.setAttribute('data-risu-sortable-list', '')
    const row = document.createElement('div')
    row.setAttribute('data-sortable-key', '7')
    list.appendChild(row)
    holder.appendChild(list)
    document.body.appendChild(holder)
    return { list, row, group }
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))

afterEach(() => {
    localStorage.removeItem('risu-debug-drag')
    document.body.innerHTML = ''
})

describe('drag diagnostics', () => {
    it('stays off without the flag: lists keep their options and nothing is drawn', async () => {
        const debug = await load()
        const options = { onMove: () => true }
        debug.initDragDebug()
        expect(debug.dragDebugOn()).toBe(false)
        expect(debug.withDragDebug(options)).toBe(options)
        expect(document.querySelector('[data-drag-debug]')).toBeNull()
    })

    it('with the flag, names the list, keeps onMove answers and shows the drag', async () => {
        localStorage.setItem('risu-debug-drag', '1')
        const debug = await load()
        const { default: Sortable } = await import('sortablejs')
        debug.initDragDebug()
        expect(debug.dragDebugOn()).toBe(true)

        const { list, row } = folderList('abcdef123456', 'foldered-list-items')
        const root = folderList('', 'foldered-list-items')
        const sortable = Sortable.create(list, debug.withDragDebug({ group: 'foldered-list-items', onMove: () => false as boolean }))
        Sortable.create(root.list, { group: 'foldered-list-items' })
        expect(debug.listLabel(list)).toBe('items#0 f-abcdef')
        expect(debug.listLabel(root.row)).toBe('items#1 root')

        // The answer passes through unchanged.
        const onMove = sortable.options.onMove as (event: unknown, original: Event) => unknown
        expect(onMove({ related: row, to: list }, new Event('x'))).toBe(false)

        const plugin = (sortable as unknown as { dragDebug: Record<string, (event: object) => void> }).dragDebug
        plugin.dragStartedGlobal({ sortable })
        plugin.dragOverGlobal({ sortable: Sortable.get(root.list) })
        plugin.dragOverValidGlobal({})
        plugin.dragOverCompletedGlobal({ insertion: true })
        expect(onMove({ related: row, to: list }, new Event('x'))).toBe(false)
        await nextFrame()
        const text = document.querySelector('[data-drag-debug]')?.textContent ?? ''
        expect(text).toContain('from   items#0 f-abcdef')
        expect(text).toContain('over   items#1 root ok +ins')
        expect(text).toContain('onMove items#0 f-abcdef row 7 -> false')
        expect(text).toContain('refused 1')
        expect((document.querySelector('[data-drag-debug]') as HTMLElement).style.pointerEvents).toBe('none')
        plugin.nullingGlobal({})
    })
})
