import { describe, expect, it } from 'vitest'
import { groupByFolder, isFolderCollapsed } from './folders'

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
