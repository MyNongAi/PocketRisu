import { describe, expect, it } from 'vitest'
import {
    assignModuleToFolder,
    buildModuleFolderCatalog,
    findModuleFolderId,
    moveModuleByDrop,
    moveModuleFolderByDrop,
    normalizeModuleFolders,
    type ModuleFolder,
} from './moduleFolders'
import { sortModulesByActivation } from './moduleSort'

const modules = [
    { id: 'recent', name: 'Recent' },
    { id: 'alpha', name: 'Alpha' },
    { id: 'middle', name: 'Middle' },
    { id: 'omega', name: 'Omega' },
]

describe('buildModuleFolderCatalog', () => {
    it('keeps the exact incoming order when no folders exist', () => {
        const entries = buildModuleFolderCatalog(modules, undefined)

        expect(entries.map((entry) => entry.kind === 'module' ? entry.module.id : entry.folder.id))
            .toEqual(['recent', 'alpha', 'middle', 'omega'])
    })

    it('anchors a folder at its first visible member and preserves member order', () => {
        const folders: ModuleFolder[] = [{
            id: 'favorites',
            name: 'Favorites',
            moduleIds: ['omega', 'alpha'],
        }]

        const entries = buildModuleFolderCatalog(modules, folders)

        expect(entries.map((entry) => entry.kind === 'module'
            ? entry.module.id
            : `${entry.folder.id}:${entry.modules.map((module) => module.id).join(',')}`,
        )).toEqual([
            'recent',
            'favorites:alpha,omega',
            'middle',
        ])
        expect(modules.map((module) => module.id)).toEqual(['recent', 'alpha', 'middle', 'omega'])
    })

    it('moves the folder with its most recently activated member without rewriting source order', () => {
        const source = [
            { id: 'alpha', name: 'Alpha' },
            { id: 'middle', name: 'Middle' },
            { id: 'omega', name: 'Omega' },
        ]
        const sorted = sortModulesByActivation(source, '', {
            activationHistory: ['omega'],
        })
        const entries = buildModuleFolderCatalog(sorted, [{
            id: 'favorites',
            name: 'Favorites',
            moduleIds: ['middle', 'omega'],
        }])

        expect(entries.map((entry) => entry.kind === 'module'
            ? entry.module.id
            : `${entry.folder.id}:${entry.modules.map((module) => module.id).join(',')}`,
        )).toEqual(['favorites:omega,middle', 'alpha'])
        expect(source.map((module) => module.id)).toEqual(['alpha', 'middle', 'omega'])
    })

    it('keeps duplicate-id module objects distinct for object-identity render keys', () => {
        const first = { id: 'same', name: 'First' }
        const second = { id: 'same', name: 'Second' }
        const entries = buildModuleFolderCatalog([first, second], undefined)

        expect(entries).toEqual([
            { kind: 'module', module: first },
            { kind: 'module', module: second },
        ])
        expect(entries[0].kind === 'module' && entries[0].module).not.toBe(
            entries[1].kind === 'module' && entries[1].module,
        )
    })

    it('searches module names and expands all members when the folder name matches', () => {
        const folders: ModuleFolder[] = [{
            id: 'favorites',
            name: 'Favorites',
            moduleIds: ['alpha', 'omega'],
        }]

        const moduleMatch = buildModuleFolderCatalog(modules, folders, 'omega')
        expect(moduleMatch).toHaveLength(1)
        expect(moduleMatch[0].kind === 'folder' && moduleMatch[0].modules.map((module) => module.id))
            .toEqual(['omega'])

        const folderMatch = buildModuleFolderCatalog(modules, folders, 'favor')
        expect(folderMatch).toHaveLength(1)
        expect(folderMatch[0].kind === 'folder' && folderMatch[0].modules.map((module) => module.id))
            .toEqual(['alpha', 'omega'])
    })

    it('keeps similarity folders above empty folders and ignores stale module ids', () => {
        const entries = buildModuleFolderCatalog(modules, [
            { id: 'stale', name: 'Stale', moduleIds: ['missing'] },
            { id: 'empty', name: 'Empty', moduleIds: [] },
            {
                id: 'similar',
                name: '[유사 후보] Similar',
                moduleIds: ['omega'],
            },
        ])

        expect(entries.slice(0, 3).map((entry) => entry.kind === 'folder' ? entry.folder.id : 'module'))
            .toEqual(['similar', 'stale', 'empty'])
    })

    it('uses the first folder when malformed metadata duplicates membership', () => {
        const entries = buildModuleFolderCatalog(modules, [
            { id: 'first', name: 'First', moduleIds: ['alpha'] },
            { id: 'second', name: 'Second', moduleIds: ['alpha'] },
        ])

        const first = entries.find((entry) => entry.kind === 'folder' && entry.folder.id === 'first')
        const second = entries.find((entry) => entry.kind === 'folder' && entry.folder.id === 'second')
        expect(first?.kind === 'folder' && first.modules.map((module) => module.id)).toEqual(['alpha'])
        expect(second?.kind === 'folder' && second.modules).toEqual([])
    })
})

describe('module folder membership', () => {
    it('moves a module exclusively and can return it to the root list', () => {
        const folders: ModuleFolder[] = [
            { id: 'a', name: 'A', moduleIds: ['recent', 'alpha'] },
            { id: 'b', name: 'B', moduleIds: ['middle'] },
        ]

        const moved = assignModuleToFolder(folders, 'alpha', 'b')
        expect(moved).toEqual([
            { id: 'a', name: 'A', moduleIds: ['recent'] },
            { id: 'b', name: 'B', moduleIds: ['middle', 'alpha'] },
        ])
        expect(findModuleFolderId(moved, 'alpha')).toBe('b')

        const unfiled = assignModuleToFolder(moved, 'alpha', '')
        expect(findModuleFolderId(unfiled, 'alpha')).toBe('')
        expect(unfiled[1].moduleIds).toEqual(['middle'])
    })

    it('treats an unknown target as no folder', () => {
        const folders: ModuleFolder[] = [{ id: 'a', name: 'A', moduleIds: ['alpha'] }]
        expect(assignModuleToFolder(folders, 'alpha', 'missing')[0].moduleIds).toEqual([])
    })
})

describe('module drag and drop', () => {
    const folders: ModuleFolder[] = [
        { id: 'favorites', name: 'Favorites', moduleIds: ['alpha', 'omega'] },
        { id: 'empty', name: 'Empty', moduleIds: [] },
    ]

    it('reorders root modules without changing their folder membership', () => {
        const moved = moveModuleByDrop(
            ['recent', 'alpha', 'omega', 'middle'],
            folders,
            'middle',
            { kind: 'module', moduleId: 'recent', position: 'before' },
        )

        expect(moved.orderedModuleIds).toEqual(['middle', 'recent', 'alpha', 'omega'])
        expect(findModuleFolderId(moved.folders, 'middle')).toBe('')
    })

    it('moves a module into a folder and appends it after that folder members', () => {
        const moved = moveModuleByDrop(
            ['recent', 'alpha', 'omega', 'middle'],
            folders,
            'recent',
            { kind: 'folder', folderId: 'favorites' },
        )

        expect(moved.orderedModuleIds).toEqual(['alpha', 'omega', 'recent', 'middle'])
        expect(moved.folders[0].moduleIds).toEqual(['alpha', 'omega', 'recent'])
    })

    it('moves between folders by dropping beside a member', () => {
        const moved = moveModuleByDrop(
            ['recent', 'alpha', 'omega', 'middle'],
            folders,
            'middle',
            { kind: 'module', moduleId: 'alpha', position: 'after' },
        )

        expect(moved.orderedModuleIds).toEqual(['recent', 'alpha', 'middle', 'omega'])
        expect(moved.folders[0].moduleIds).toEqual(['alpha', 'middle', 'omega'])
    })

    it('returns a nested module to the root list', () => {
        const moved = moveModuleByDrop(
            ['recent', 'alpha', 'omega', 'middle'],
            folders,
            'alpha',
            { kind: 'root' },
        )

        expect(moved.orderedModuleIds).toEqual(['recent', 'omega', 'middle', 'alpha'])
        expect(findModuleFolderId(moved.folders, 'alpha')).toBe('')
    })

    it('does not mutate inputs or lose stale folder metadata', () => {
        const contaminated: ModuleFolder[] = [{
            id: 'favorites',
            name: 'Favorites',
            moduleIds: ['alpha', 'stale', 'omega'],
        }]
        const moved = moveModuleByDrop(
            ['recent', 'alpha', 'omega'],
            contaminated,
            'recent',
            { kind: 'folder', folderId: 'favorites' },
        )

        expect(contaminated[0].moduleIds).toEqual(['alpha', 'stale', 'omega'])
        expect(moved.folders[0].moduleIds).toEqual(['alpha', 'omega', 'recent', 'stale'])
    })
})

describe('module folder drag and drop', () => {
    const folders: ModuleFolder[] = [
        { id: 'first', name: 'First', moduleIds: ['alpha', 'omega'] },
        { id: 'second', name: 'Second', moduleIds: ['middle'] },
        { id: 'empty', name: 'Empty', moduleIds: [] },
    ]

    it('moves every member as one block beside a root module', () => {
        const moved = moveModuleFolderByDrop(
            ['recent', 'alpha', 'omega', 'middle'],
            folders,
            'first',
            { kind: 'module', moduleId: 'recent', position: 'before' },
        )

        expect(moved.orderedModuleIds).toEqual(['alpha', 'omega', 'recent', 'middle'])
        expect(moved.folders.find((folder) => folder.id === 'first')?.moduleIds)
            .toEqual(['alpha', 'omega'])
    })

    it('moves a folder before another folder as a complete block', () => {
        const moved = moveModuleFolderByDrop(
            ['recent', 'alpha', 'omega', 'middle'],
            folders,
            'second',
            { kind: 'folder', folderId: 'first', position: 'before' },
        )

        expect(moved.orderedModuleIds).toEqual(['recent', 'middle', 'alpha', 'omega'])
        expect(moved.folders.map((folder) => folder.id)).toEqual(['second', 'first', 'empty'])
    })

    it('reorders empty folders without inventing module ids', () => {
        const moved = moveModuleFolderByDrop(
            ['recent', 'alpha', 'omega', 'middle'],
            folders,
            'empty',
            { kind: 'folder', folderId: 'first', position: 'before' },
        )

        expect(moved.orderedModuleIds).toEqual(['recent', 'alpha', 'omega', 'middle'])
        expect(moved.folders.map((folder) => folder.id)).toEqual(['empty', 'first', 'second'])
    })
})

describe('normalizeModuleFolders', () => {
    it.each([undefined, null, 'folders', { id: 'not-an-array' }])('rejects non-array metadata: %j', value => {
        expect(normalizeModuleFolders(value)).toEqual([])
    })

    it('normalizes consumed fields and keeps the first folder and membership', () => {
        const folders = normalizeModuleFolders([
            null,
            { id: '', name: 'Invalid', moduleIds: ['ignored'] },
            { id: 'first', name: null, moduleIds: ['alpha', 'alpha', 7], collapsed: 'true', color: 'green' },
            { id: 'first', name: 'Duplicate id', moduleIds: ['ignored'] },
            { id: 'second', name: 'Second', moduleIds: ['alpha', 'beta'], collapsed: false },
        ])

        expect(folders).toEqual([
            { id: 'first', name: '', moduleIds: ['alpha'], color: 'green' },
            { id: 'second', name: 'Second', moduleIds: ['beta'], collapsed: false },
        ])
    })

    it('makes every helper safe against contaminated metadata', () => {
        expect(buildModuleFolderCatalog(modules, { invalid: true })).toHaveLength(modules.length)
        expect(findModuleFolderId({ invalid: true }, 'alpha')).toBe('')
        expect(assignModuleToFolder({ invalid: true }, 'alpha', 'target')).toEqual([])
    })
})
