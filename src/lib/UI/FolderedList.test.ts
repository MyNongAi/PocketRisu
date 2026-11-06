import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet, mount, tick, unmount } from 'svelte'
import type Sortable from 'sortablejs'
import FolderedList from './FolderedList.svelte'

const mocks = vi.hoisted(() => ({
    input: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    sortableCreate: vi.fn((_element: HTMLElement, _options: Sortable.Options): Pick<Sortable, 'destroy'> => ({ destroy: vi.fn() })),
}))
vi.mock('src/ts/alert', () => ({ alertInput: mocks.input, alertSelect: mocks.select, alertConfirm: mocks.confirm }))
vi.mock('src/ts/util', () => ({ sortableOptions: {} }))
vi.mock('src/lang', () => ({ language: {
    search: 'Search', folderNew: 'New folder', folderNameInput: 'Name', folderUncategorized: 'Uncategorized',
    renameFolder: 'Rename', moveUp: 'Up', moveDown: 'Down', cancel: 'Cancel', remove: 'Delete', folderMoveTo: 'Move to',
    storageShowingOf: (shown: number, total: number) => `${shown} of ${total} shown`,
} }))
vi.mock('sortablejs', () => ({ default: { create: mocks.sortableCreate } }))
// Test the list's own state transitions without transforming the entire icon/menu library.
vi.mock('@lucide/svelte', async () => {
    const { default: Icon } = await import('./test/FolderedListIcon.svelte')
    return { ChevronDownIcon: Icon, ChevronRightIcon: Icon, EllipsisVerticalIcon: Icon,
        FolderIcon: Icon, FolderInputIcon: Icon, FolderOutputIcon: Icon, FolderPlusIcon: Icon, PaletteIcon: Icon, SearchIcon: Icon, StarIcon: Icon, XIcon: Icon }
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
        itemContent: createRawSnippet((getIndex) => ({ render: () => `<span>Module ${getIndex()}</span>` })),
        onSelect: vi.fn(), onItemsChange: vi.fn(), onFoldersChange,
        ...overrides,
    } })
    mounted.push(instance)
    await tick()
    return { target, onFoldersChange }
}

beforeEach(() => {
    localStorage.clear(); vi.clearAllMocks()
    mocks.sortableCreate.mockImplementation(() => ({ destroy: vi.fn() }))
})
afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)))
    vi.useRealTimers()
    document.body.replaceChildren()
})

describe('module folder display interactions', () => {
    it('keeps touch previews outside the nested item lists and their containing blocks', async () => {
        const { default: RealSortable } = await vi.importActual<{ default: typeof Sortable }>('sortablejs')
        mocks.sortableCreate.mockImplementation((element, options) => RealSortable.create(element, options))
        const { target } = await renderList({ defaultCollapsed: false })
        const row = target.querySelector<HTMLElement>('[data-sortable-key="0"]')!
        vi.useFakeTimers()
        for (const type of ['pointerdown', 'pointermove']) {
            row.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', button: 0, clientX: 10, clientY: 10 }))
        }
        vi.advanceTimersByTime(0)
        expect(RealSortable.ghost?.parentElement).toBe(document.body)
        row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }))
        vi.advanceTimersByTime(400)
        document.body.click() // Consume Sortable's synthetic-click suppression before the next test.
    })

    it('filters Korean initials without exposing unrelated folders or rewriting membership', async () => {
        const onItemsChange = vi.fn()
        const { target, onFoldersChange } = await renderList({ itemSearchTexts: ['넬리 섬', '다른 모듈'], onItemsChange, showItemCount: true })
        const input = target.querySelector<HTMLInputElement>('input')!
        expect(input.parentElement?.textContent).toContain('2/2')
        input.value = 'ㄴㄹㅅ'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        expect(target.textContent).toContain('Alpha')
        expect(target.textContent).not.toContain('Beta')
        expect(target.textContent).toContain('Module 0')
        expect(target.textContent).not.toContain('Module 1')
        expect(input.parentElement?.textContent).toContain('1/2')
        expect(input.parentElement?.textContent).toContain('1 of 2 shown')
        expect(onItemsChange).not.toHaveBeenCalled()
        expect(onFoldersChange).not.toHaveBeenCalled()
    })

    it('starts collapsed and remembers an explicit expansion on the next mount', async () => {
        const first = await renderList()
        expect(first.target.querySelector('.risu-field-border span')).toBeNull()
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
        expect(target.querySelector('[data-folder-container="b"]')).toBeNull()
        expect(target.textContent).toContain('Alpha')
        expect(target.textContent).not.toContain('Beta')
        expect(target.textContent).toContain('Module 0')
        expect(target.textContent).not.toContain('Module 1')
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        expect(target.querySelector('[data-folder-container="a"]')?.classList.contains('hidden')).toBe(true)
        expect(target.querySelector('[data-folder-container="b"]')).not.toBeNull()
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

    it('moves an item from a folder into the uncategorized drop zone', async () => {
        const onItemsChange = vi.fn()
        const { target } = await renderList({ onItemsChange, defaultCollapsed: false })
        const source = target.querySelector<HTMLElement>('[data-folder-container="a"] [data-risu-sortable-list]')!
        const destination = target.querySelector<HTMLElement>('[data-folder-container=""] [data-risu-sortable-list]')!
        const item = source.querySelector<HTMLElement>('[data-sortable-key="0"]')!
        const sourceCall = mocks.sortableCreate.mock.calls.find(([element]) => element === source)
        const options = sourceCall?.[1] as unknown as {
            onStart: (event: Record<string, unknown>) => void
            onEnd: (event: Record<string, unknown>) => void
        }

        options.onStart({ item, from: source })
        destination.append(item)
        options.onEnd({
            item,
            from: source,
            to: destination,
            oldIndex: 0,
            oldDraggableIndex: 0,
            newIndex: 0,
            newDraggableIndex: 0,
        })

        expect(onItemsChange).toHaveBeenCalledOnce()
        expect(onItemsChange.mock.calls[0][0]).toEqual([
            { index: 1, folderId: 'b' },
            { index: 0, folderId: undefined },
        ])
    })

    it('a folder dropped among loose items counts as moved though it passed no other folder', async () => {
        // The user's report, 2026-11-07: in 최근순 a folder put between single
        // modules went back; only a move past another folder stayed.
        const onItemsChange = vi.fn()
        const { target, onFoldersChange } = await renderList({
            folders: [{ id: 'a', name: 'Alpha' }],
            itemFolderIds: [undefined, 'a', undefined],
            itemSearchTexts: ['root-0', 'in-a', 'root-2'],
            interleaveItems: true,
            onItemsChange,
            defaultCollapsed: false,
        })
        const outer = target.querySelector<HTMLElement>('[data-risu-sortable-list]')!
        const folder = outer.querySelector<HTMLElement>(':scope > [data-folder-key="a"]')!
        const blocks = () => Array.from(outer.children).map((child) => child.getAttribute('data-folder-key') ?? 'root')
        expect(blocks()).toEqual(['root', 'a', 'root'])
        const options = mocks.sortableCreate.mock.calls.find(([element]) => element === outer)?.[1] as unknown as {
            onStart: (event: Record<string, unknown>) => void
            onEnd: (event: Record<string, unknown>) => void
        }

        options.onStart({ item: folder, from: outer })
        outer.append(folder)
        options.onEnd({ item: folder, from: outer, to: outer, oldIndex: 1, newIndex: 2, oldDraggableIndex: 0, newDraggableIndex: 0 })

        expect(onFoldersChange).toHaveBeenCalledOnce()
        expect(onItemsChange).toHaveBeenCalledOnce()
        expect(onItemsChange.mock.calls[0]).toEqual([[
            { index: 0, folderId: undefined },
            { index: 2, folderId: undefined },
            { index: 1, folderId: 'a' },
        ], true])
    })

    it('a folder held over single items and dropped inside their list is placed between them', async () => {
        // What the touch drag did (trace, 2026-11-07): over single modules the
        // folder lands inside their list, which counted its items twice (82 of
        // 80), so nothing was saved and the folder went back.
        const onItemsChange = vi.fn()
        const { target, onFoldersChange } = await renderList({
            folders: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }],
            itemFolderIds: ['a', undefined, undefined, 'b'],
            itemSearchTexts: ['in-a', 'root-1', 'root-2', 'in-b'],
            interleaveItems: true,
            rootItemsStandalone: true,
            onItemsChange,
            defaultCollapsed: false,
        })
        const outer = target.querySelector<HTMLElement>('[data-risu-sortable-list]')!
        const blocks = Array.from(outer.children).map((child) => child.getAttribute('data-folder-key') ?? 'root')
        expect(blocks).toEqual(['a', 'root', 'b'])
        const folder = outer.querySelector<HTMLElement>(':scope > [data-folder-key="b"]')!
        const rootList = outer.querySelector<HTMLElement>(':scope > [data-folder-container=""] [data-risu-sortable-list]')!
        const rowTwo = rootList.querySelector<HTMLElement>('[data-sortable-key="2"]')!
        const options = mocks.sortableCreate.mock.calls.find(([element]) => element === outer)?.[1] as unknown as {
            onStart: (event: Record<string, unknown>) => void
            onEnd: (event: Record<string, unknown>) => void
        }

        options.onStart({ item: folder, from: outer })
        rootList.insertBefore(folder, rowTwo)
        options.onEnd({ item: folder, from: outer, to: rootList, oldIndex: 2, newIndex: 1, oldDraggableIndex: 1, newDraggableIndex: 0 })

        expect(onItemsChange).toHaveBeenCalledOnce()
        expect(onItemsChange.mock.calls[0]).toEqual([[
            { index: 0, folderId: 'a' },
            { index: 1, folderId: undefined },
            { index: 3, folderId: 'b' },
            { index: 2, folderId: undefined },
        ], true])
        // The folders keep the order they show in.
        expect(onFoldersChange.mock.calls[0][0].map((f: { id: string }) => f.id)).toEqual(['a', 'b'])
        // The page is handed back as it was (Svelte redraws it from the data).
        expect(Array.from(outer.children).map((child) => child.getAttribute('data-folder-key') ?? 'root')).toEqual(['a', 'root', 'b'])
    })

    it('can render standalone root items before real folders for recent ordering', async () => {
        const { target } = await renderList({
            itemFolderIds: [undefined, 'a'],
            itemSearchTexts: ['root', 'foldered'],
            rootItemsStandalone: true,
            rootItemsFirst: true,
            defaultCollapsed: false,
        })
        const list = target.querySelector('[data-risu-sortable-list]')!
        const root = list.querySelector<HTMLElement>(':scope > [data-folder-container=""]')!
        const folder = list.querySelector<HTMLElement>(':scope > [data-folder-key="a"]')!
        expect(root).not.toBeNull()
        expect(folder).not.toBeNull()
        expect(root.compareDocumentPosition(folder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(root.textContent).toContain('Module 0')
    })

    it('promotes only the selected loose item, not every loose item', async () => {
        const { target } = await renderList({
            itemFolderIds: [undefined, 'a', undefined, 'b'],
            itemSearchTexts: ['root-a', 'folder-a', 'root-b', 'folder-b'],
            rootItemsStandalone: true,
            promotedItemIndex: 2,
            defaultCollapsed: false,
        })
        const list = target.querySelector('[data-risu-sortable-list]')!
        const children = Array.from(list.children) as HTMLElement[]
        expect(children[0].dataset.folderContainer).toBe('')
        expect(children[0].textContent).toContain('Module 2')
        expect(children[0].textContent).not.toContain('Module 0')
        expect(children[1].dataset.folderKey).toBe('a')
        expect(children[2].dataset.folderKey).toBe('b')
        expect(children[3].textContent).toContain('Module 0')
    })

    it('promotes only the selected member folder, not every folder', async () => {
        const { target } = await renderList({
            itemFolderIds: [undefined, 'a', undefined, 'b'],
            itemSearchTexts: ['root-a', 'folder-a', 'root-b', 'folder-b'],
            rootItemsStandalone: true,
            promotedFolderId: 'b',
            defaultCollapsed: false,
        })
        const list = target.querySelector('[data-risu-sortable-list]')!
        const children = Array.from(list.children) as HTMLElement[]
        expect(children[0].dataset.folderKey).toBe('b')
        expect(children[1].dataset.folderContainer).toBe('')
        expect(children[1].textContent).toContain('Module 0')
        expect(children[1].textContent).toContain('Module 2')
        expect(children[2].dataset.folderKey).toBe('a')
    })
})
