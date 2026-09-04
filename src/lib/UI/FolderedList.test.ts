import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet, mount, tick, unmount } from 'svelte'
import FolderedList from './FolderedList.svelte'

const mocks = vi.hoisted(() => ({ input: vi.fn(), select: vi.fn(), confirm: vi.fn() }))
vi.mock('src/ts/alert', () => ({ alertInput: mocks.input, alertSelect: mocks.select, alertConfirm: mocks.confirm }))
vi.mock('src/ts/util', () => ({ sortableOptions: {} }))
vi.mock('src/lang', () => ({ language: {
    search: 'Search', folderNew: 'New folder', folderNameInput: 'Name', folderUncategorized: 'Uncategorized',
    renameFolder: 'Rename', moveUp: 'Up', moveDown: 'Down', cancel: 'Cancel', remove: 'Delete', folderMoveTo: 'Move to',
} }))
vi.mock('sortablejs', () => ({ default: { create: vi.fn(() => ({ destroy: vi.fn() })) } }))
// Test the list's own state transitions without transforming the entire icon/menu library.
vi.mock('@lucide/svelte', async () => {
    const { default: Icon } = await import('./test/FolderedListIcon.svelte')
    return { ChevronDownIcon: Icon, ChevronRightIcon: Icon, EllipsisVerticalIcon: Icon,
        FolderIcon: Icon, FolderPlusIcon: Icon, PaletteIcon: Icon, SearchIcon: Icon, StarIcon: Icon }
})
vi.mock('./GUI/ShDropdownMenu.svelte', () => import('./test/FolderedListSlot.svelte'))
vi.mock('./GUI/ShDropdownMenuTrigger.svelte', () => import('./test/FolderedListSlot.svelte'))
vi.mock('./GUI/ShDropdownMenuContent.svelte', () => import('./test/FolderedListSlot.svelte'))
vi.mock('./GUI/ShDropdownMenuItem.svelte', () => import('./test/FolderedListSlot.svelte'))
vi.mock('./GUI/ShDropdownMenuSeparator.svelte', () => import('./test/FolderedListSlot.svelte'))

const mounted: ReturnType<typeof mount>[] = []
const folders = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]
const storageKey = 'module-expanded-test'

async function renderList(overrides: Record<string, unknown> = {}) {
    const target = document.createElement('div')
    document.body.append(target)
    const onFoldersChange = vi.fn()
    const instance = mount(FolderedList, { target, props: {
        folders, itemFolderIds: ['a', 'b'], itemSearchTexts: ['first', 'second'],
        defaultCollapsed: true, newFoldersFirst: true, storageKey,
        itemContent: createRawSnippet(() => ({ render: () => '<span>Module</span>' })),
        onSelect: vi.fn(), onItemsChange: vi.fn(), onFoldersChange,
        ...overrides,
    } })
    mounted.push(instance)
    await tick()
    return { target, onFoldersChange }
}

beforeEach(() => { localStorage.clear(); vi.clearAllMocks() })
afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)))
    document.body.replaceChildren()
})

describe('module folder display interactions', () => {
    it('starts collapsed and remembers an explicit expansion on the next mount', async () => {
        const first = await renderList()
        expect(first.target.querySelector('[data-folder-container="a"]')?.classList.contains('hidden')).toBe(true)
        first.target.querySelector<HTMLElement>('[data-folder-key="a"] > [role="button"]')!.click()
        await tick()
        expect(first.target.querySelector('[data-folder-container="a"]')?.classList.contains('hidden')).toBe(false)
        expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(['a'])
        const second = await renderList()
        expect(second.target.querySelector('[data-folder-container="a"]')?.classList.contains('hidden')).toBe(false)
        expect(second.target.querySelector('[data-folder-container="b"]')?.classList.contains('hidden')).toBe(true)
    })

    it('expands search results temporarily, without rewriting the saved fold state', async () => {
        const { target } = await renderList()
        const input = target.querySelector<HTMLInputElement>('input')!
        input.value = 'first'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        expect(target.querySelector('[data-folder-container="a"]')?.classList.contains('hidden')).toBe(false)
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        expect(target.querySelector('[data-folder-container="a"]')?.classList.contains('hidden')).toBe(true)
        expect(localStorage.getItem(storageKey)).toBeNull()
    })

    it('does not create on cancel; creates at the top and starts new folders collapsed', async () => {
        const { target, onFoldersChange } = await renderList()
        const create = Array.from(target.querySelectorAll('button')).find((button) => button.textContent?.includes('New folder'))!
        mocks.input.mockResolvedValueOnce(null)
        create.click()
        await tick()
        expect(onFoldersChange).not.toHaveBeenCalled()
        mocks.input.mockResolvedValueOnce('New')
        create.click()
        await tick()
        expect(onFoldersChange).toHaveBeenCalledOnce()
        const next = onFoldersChange.mock.calls[0][0]
        expect(next.map((folder: { name: string }) => folder.name)).toEqual(['New', 'Alpha', 'Beta'])
        const reopened = await renderList({ folders: next })
        expect(reopened.target.querySelector(`[data-folder-container="${next[0].id}"]`)?.classList.contains('hidden')).toBe(true)
    })
})
