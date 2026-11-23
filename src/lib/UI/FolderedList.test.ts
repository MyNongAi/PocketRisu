import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet, mount, tick, unmount } from 'svelte'
import type Sortable from 'sortablejs'
import type { PromptPresetFolder } from 'src/ts/storage/database.svelte'
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
const nestedFolders = [
    { id: 'top', name: 'Collection' },
    { id: 'child', name: 'Inner', nodeOnlyParentFolderId: 'top' },
    { id: 'deep', name: 'Deep', nodeOnlyParentFolderId: 'child' },
    { id: 'other', name: 'Other' },
]
const nestedFolderActions = createRawSnippet<[PromptPresetFolder, number[], number[]]>((getFolder, getDirect, getShown) => ({
    render: () => `<span data-folder-actions="${getFolder().id}" data-direct="${getDirect().join(',')}" data-shown="${getShown().join(',')}"></span>`,
}))
const nestedListProps = {
    folders: nestedFolders,
    itemFolderIds: ['top', 'child', 'deep', 'deep', 'other'],
    itemSearchTexts: ['cartridge direct', 'cartridge child', 'cartridge deep', 'hidden deep', 'cartridge elsewhere'],
    maxFolderDepth: 3,
    folderActions: nestedFolderActions,
}

function folderActionIndexes(target: HTMLElement, folderId: string, attribute: 'direct' | 'shown') {
    const value = target.querySelector<HTMLElement>(`[data-folder-actions="${folderId}"]`)?.dataset[attribute]
    expect(value).toBeDefined()
    return value ? value.split(',').map(Number) : []
}

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
    // NESTED-FOLDER-DRAG (2026-11-23): drive the same Sortable callbacks as a pointer drop.
    async function dragFolder(target: HTMLElement, id: string, destinationKey: string | null, beforeId?: string) {
        const item = target.querySelector<HTMLElement>(`[data-folder-key="${id}"]`)!;
        const source = item.parentElement!;
        const destination = destinationKey === null
            ? target.querySelector<HTMLElement>('[data-risu-sortable-list]:not([data-sortable-container-key])')!
            : target.querySelector<HTMLElement>(`[data-sortable-container-key="${destinationKey}"]`)!;
        const options = mocks.sortableCreate.mock.calls.find(([element]) => element === source)?.[1] as unknown as {
            onStart: (event: Record<string, unknown>) => void
            onEnd: (event: Record<string, unknown>) => void
        };
        const oldIndex = Array.from(source.children).indexOf(item);
        options.onStart({ item, from: source });
        destination.insertBefore(item, beforeId ? destination.querySelector(`[data-folder-key="${beforeId}"]`) : null);
        const newIndex = Array.from(destination.children).indexOf(item);
        options.onEnd({ item, from: source, to: destination, oldIndex, newIndex, oldDraggableIndex: oldIndex, newDraggableIndex: newIndex });
        await tick();
    }

    it('filters a press on a nested folder from the outer parent drag', async () => {
        const { target, onFoldersChange } = await renderList({ ...nestedListProps, defaultCollapsed: false });
        const outer = target.querySelector<HTMLElement>('[data-risu-sortable-list]:not([data-sortable-container-key])')!;
        const options = mocks.sortableCreate.mock.calls.find(([element]) => element === outer)?.[1] as Sortable.Options;
        const header = target.querySelector<HTMLElement>('[data-nested-folder="child"] [data-folder-header]')!;
        expect((options.filter as (event: Event) => boolean)({ target: header } as unknown as Event)).toBe(true);
        expect((options.filter as (event: Event) => boolean)({ target: target.querySelector('[data-folder-key="top"] [data-folder-header]') } as unknown as Event)).toBe(false);
        expect(onFoldersChange).not.toHaveBeenCalled();
    });

    it('reorders sibling folders without moving their parent', async () => {
        const entries = [{ id: 'top', name: 'Top' }, { id: 'a', name: 'A', nodeOnlyParentFolderId: 'top' },
            { id: 'b', name: 'B', nodeOnlyParentFolderId: 'top' }];
        const { target, onFoldersChange } = await renderList({ folders: entries, itemFolderIds: [], itemSearchTexts: [], defaultCollapsed: false, maxFolderDepth: 3 });
        await dragFolder(target, 'b', 'top', 'a');
        expect(onFoldersChange.mock.calls[0][0].map((folder: PromptPresetFolder) => folder.id)).toEqual(['top', 'b', 'a']);
        expect(onFoldersChange.mock.calls[0][0][1].nodeOnlyParentFolderId).toBe('top');
    });

    it('moves a nested folder into another folder and then to the top level', async () => {
        const { target, onFoldersChange } = await renderList({ ...nestedListProps, defaultCollapsed: false });
        await dragFolder(target, 'deep', 'other');
        expect(onFoldersChange.mock.calls[0][0].find((folder: PromptPresetFolder) => folder.id === 'deep').nodeOnlyParentFolderId).toBe('other');
        const moved = onFoldersChange.mock.calls[0][0] as PromptPresetFolder[];
        const second = await renderList({ ...nestedListProps, folders: moved, defaultCollapsed: false });
        await dragFolder(second.target, 'deep', null, 'top');
        const out = second.onFoldersChange.mock.calls[0][0] as PromptPresetFolder[];
        expect(out.find(folder => folder.id === 'deep')?.nodeOnlyParentFolderId).toBeUndefined();
        expect(out[0].id).toBe('deep');
    });

    // A drop into its own descendant cannot happen in the page (the folder
    // holds that list); the hover guard below refuses it before that.
    it('refuses a drop that would nest deeper than allowed', async () => {
        const entries = [...nestedFolders, { id: 'otherSub', name: 'Other sub', nodeOnlyParentFolderId: 'other' },
            { id: 'otherDeep', name: 'Other deep', nodeOnlyParentFolderId: 'otherSub' }];
        const { target, onFoldersChange } = await renderList({ ...nestedListProps, folders: entries, defaultCollapsed: false });
        // `child` holds `deep`: inside `otherDeep` (depth 2) that would be depth 4 > 3.
        await dragFolder(target, 'child', 'otherDeep');
        expect(onFoldersChange).not.toHaveBeenCalled();
    });

    function listOptions(target: HTMLElement, key: string | null) {
        const list = key === null
            ? target.querySelector<HTMLElement>('[data-risu-sortable-list]:not([data-sortable-container-key])')!
            : target.querySelector<HTMLElement>(`[data-sortable-container-key="${key}"]`)!;
        const options = mocks.sortableCreate.mock.calls.filter(([element]) => element === list).at(-1)?.[1] as unknown as {
            onStart: (event: Record<string, unknown>) => void
            onEnd: (event: Record<string, unknown>) => void
            onMove: (event: Record<string, unknown>) => boolean
        };
        return { list, options };
    }

    it('shows an empty drop box only under folders the dragged folder may enter', async () => {
        const { target } = await renderList({ ...nestedListProps, defaultCollapsed: false });
        const deepList = () => target.querySelector<HTMLElement>('[data-sortable-container-key="deep"]')!;
        const otherList = () => target.querySelector<HTMLElement>('[data-sortable-container-key="other"]')!;
        expect(deepList().className).not.toContain('min-h-8');
        const { list, options } = listOptions(target, null);
        const item = target.querySelector<HTMLElement>('[data-folder-key="other"]')!;
        options.onStart({ item, from: list });
        await tick();
        expect(deepList().className).toContain('border-dashed');
        // Its own empty list takes no drop.
        expect(otherList().className).not.toContain('min-h-8');
        options.onEnd({ item, from: list, to: list, oldIndex: 1, newIndex: 1, oldDraggableIndex: 1, newDraggableIndex: 1 });
        await tick();
        expect(deepList().className).not.toContain('min-h-8');
    });

    it('does not let a dragged folder hover into its own descendant', async () => {
        const { target } = await renderList({ ...nestedListProps, defaultCollapsed: false });
        const { list, options } = listOptions(target, 'top');
        const item = target.querySelector<HTMLElement>('[data-folder-key="child"]')!;
        options.onStart({ item, from: list });
        await tick();
        const related = document.createElement('div');
        expect(options.onMove({ related, to: listOptions(target, 'deep').list })).toBe(false);
        expect(options.onMove({ related, to: listOptions(target, 'other').list })).toBe(true);
        expect(options.onMove({ related, to: listOptions(target, null).list })).toBe(true);
    });

    it('passes direct and nested folder rows at every depth to folderActions (2026-11-20)', async () => {
        const { target } = await renderList(nestedListProps)
        expect(folderActionIndexes(target, 'top', 'direct')).toEqual([0])
        expect(folderActionIndexes(target, 'top', 'shown')).toEqual([0, 1, 2, 3])
        expect(folderActionIndexes(target, 'child', 'shown')).toEqual([1, 2, 3])
    })

    it('passes only searched rows from the whole folder subtree to folderActions', async () => {
        const { target } = await renderList({ ...nestedListProps, searchQuery: 'cartridge' })
        expect(folderActionIndexes(target, 'top', 'shown')).toEqual([0, 1, 2])
        expect(folderActionIndexes(target, 'deep', 'shown')).toEqual([2])
    })

    it('passes every descendant row when the parent folder name matches the search', async () => {
        const { target } = await renderList({ ...nestedListProps, searchQuery: 'Collection' })
        expect(folderActionIndexes(target, 'top', 'shown')).toEqual([0, 1, 2, 3])
        expect(target.querySelector('[data-folder-actions="other"]')).toBeNull()
    })

    it('lets folderCount replace the header count with the shown rows at every depth (2026-11-20)', async () => {
        const folderCount = createRawSnippet<[PromptPresetFolder, number[]]>((getFolder, getShown) => ({
            render: () => `<span data-folder-count="${getFolder().id}">${getShown().length}</span>`,
        }))
        const { target } = await renderList({ ...nestedListProps, folderCount, searchQuery: 'cartridge' })
        expect(target.querySelector('[data-folder-count="top"]')?.textContent).toBe('3')
        expect(target.querySelector('[data-folder-count="child"]')?.textContent).toBe('2')
    })

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

    it('a folder found by its name shows everything in it, with the folders inside it (2026-11-08)', async () => {
        const nested = [{ id: 'h', name: '히로인' }, { id: 'hs', name: '시즌2', nodeOnlyParentFolderId: 'h' }, { id: 'o', name: '기타' }]
        const { target } = await renderList({
            folders: nested,
            itemFolderIds: ['h', 'hs', 'o', undefined],
            itemSearchTexts: ['엘리 모듈', '외전 에셋', '다른 모듈', '루즈 모듈'],
            showItemCount: true,
        })
        const input = target.querySelector<HTMLInputElement>('input')!
        input.value = '히로인'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        expect(target.textContent).toContain('Module 0')
        expect(target.textContent).toContain('Module 1')
        expect(target.textContent).not.toContain('Module 2')
        expect(target.textContent).not.toContain('Module 3')
        expect(target.textContent).not.toContain('기타')
        expect(input.parentElement?.textContent).toContain('2/4')
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
