import { describe, expect, it } from 'vitest'
import { folderTree, groupByFolder, isFolderCollapsed, nestGroups, shownInside } from './folders'

const folders = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]

describe('groupByFolder', () => {
    it('groups indexes by folder in folder order, uncategorized last', () => {
        const groups = groupByFolder(['b', undefined, 'a', 'b'], folders)
        expect(groups.map(g => [g.folder?.id ?? null, g.indexes])).toEqual([
            ['a', [2]],
            ['b', [0, 3]],
            [null, [1]],
        ])
    })

    it('treats items pointing at a missing folder as uncategorized', () => {
        const groups = groupByFolder(['gone', 'a'], folders)
        expect(groups.find(g => g.folder === null)?.indexes).toEqual([0])
    })

    it('always yields an uncategorized group even with no folders', () => {
        const groups = groupByFolder([undefined, undefined], [])
        expect(groups).toEqual([{ folder: null, indexes: [0, 1] }])
    })
})

describe('isFolderCollapsed', () => {
    it('keeps ordinary lists open by default and respects saved collapse exceptions', () => {
        expect(isFolderCollapsed('a', new Set())).toBe(false)
        expect(isFolderCollapsed('a', new Set(['a']))).toBe(true)
    })

    it('starts module folders and newly imported folders closed, but preserves explicit expansion', () => {
        expect(isFolderCollapsed('a', new Set(), true)).toBe(true)
        expect(isFolderCollapsed('new-folder', new Set(['a']), true)).toBe(true)
        expect(isFolderCollapsed('a', new Set(['a']), true)).toBe(false)
    })

    it('leaves uncategorized modules visible with either default', () => {
        expect(isFolderCollapsed('', new Set(), true)).toBe(false)
        expect(isFolderCollapsed('', new Set(['']), true)).toBe(true)
    })
})

describe('folders in folders', () => {
    const a = { id: 'a', name: 'A' }
    const a1 = { id: 'a1', name: 'A1', nodeOnlyParentFolderId: 'a' }
    const b = { id: 'b', name: 'B' }
    const deep = { id: 'deep', name: 'Deep', nodeOnlyParentFolderId: 'a1' }
    const lost = { id: 'lost', name: 'Lost', nodeOnlyParentFolderId: 'gone' }

    it('resolves one level only; a missing or nested parent leaves the folder on top', () => {
        const folders = [a, a1, b, deep, lost]
        expect(shownInside(a1, folders)).toBe('a')
        expect(shownInside(deep, folders)).toBeUndefined()
        expect(shownInside(lost, folders)).toBeUndefined()
        expect(shownInside({ id: 'self', name: 'S', nodeOnlyParentFolderId: 'self' }, folders)).toBeUndefined()
    })

    it('puts each folder right after the one it is shown inside', () => {
        const folders = [a1, b, a]
        expect(folderTree(folders).map(({ folder, depth }) => `${folder.id}:${depth}`)).toEqual(['b:0', 'a:0', 'a1:1'])
    })

    it('nests groups and keeps the uncategorized group and orphans in place', () => {
        const folders = [a, a1, b]
        const groups = groupByFolder(['a1', 'b', undefined], folders)
        expect(nestGroups(groups, folders).map(({ group, depth }) => `${group.folder?.id ?? '-'}:${depth}`))
            .toEqual(['a:0', 'a1:1', 'b:0', '-:0'])
        // The parent group was filtered out: the child shows on its own.
        expect(nestGroups(groups.filter((group) => group.folder?.id !== 'a'), folders).map(({ group }) => group.folder?.id ?? '-'))
            .toEqual(['a1', 'b', '-'])
    })
})
