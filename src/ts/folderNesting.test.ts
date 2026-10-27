import { describe, expect, it } from 'vitest'
import type { folder } from './storage/database.svelte'
import type { OrderEntry } from './characterOrder'
import { dissolveSingletonFolders, removeFolderKeepItems } from './characterOrder'
import { folderAncestors, folderChildren, folderParents, hasChildFolders, interleaveFolderSlots, nestableParents, railRecencySnapshot, reparentChildrenOf, setFolderParent } from './folderNesting'

const f = (id: string, data: string[] = [], parent?: string, extra: Partial<folder> = {}): folder => ({
    id, name: id, color: '', data, ...(parent ? { nodeOnlyParentFolderId: parent } : {}), ...extra,
})

describe('folderParents / folderChildren', () => {
    it('resolves nestings that hold, in characterOrder order', () => {
        const order: OrderEntry[] = ['x', f('A', ['a1', 'a2']), f('B', ['b1'], 'A'), f('C', ['c1'], 'B'), f('D', ['d1'], 'A')]
        expect([...folderParents(order)]).toEqual([['B', 'A'], ['C', 'B'], ['D', 'A']])
        expect(folderChildren(order).get('A')).toEqual(['B', 'D'])
        expect(folderChildren(order).get('B')).toEqual(['C'])
        expect(hasChildFolders(order, 'A')).toBe(true)
        expect(hasChildFolders(order, 'C')).toBe(false)
    })

    it('shows a folder on top when its parent is gone, a system folder, itself, or in a loop', () => {
        const order: OrderEntry[] = [
            f('gone-parent', ['1'], 'missing'),
            f('fav', ['2'], undefined, { nodeOnlySystem: 'favorites' }),
            f('under-fav', ['3'], 'fav'),
            f('self', ['4'], 'self'),
            f('L1', ['5'], 'L2'),
            f('L2', ['6'], 'L1'),
        ]
        expect(folderParents(order).size).toBe(0)
    })
})

describe('setFolderParent / nestableParents', () => {
    const order: OrderEntry[] = [f('A', ['a']), f('B', ['b'], 'A'), f('C', ['c'], 'B'), f('E', ['e'])]

    it('offers every folder but itself, the ones inside it and system folders', () => {
        expect(nestableParents(order, 'A').map((entry) => entry.id)).toEqual(['E'])
        expect(nestableParents(order, 'C').map((entry) => entry.id)).toEqual(['A', 'B', 'E'])
    })

    it('sets and clears the parent without moving the folder', () => {
        const nested = setFolderParent(order, 'E', 'C')!
        expect(nested.map((entry) => (typeof entry === 'string' ? entry : entry.id))).toEqual(['A', 'B', 'C', 'E'])
        expect((nested[3] as folder).nodeOnlyParentFolderId).toBe('C')
        expect((nested[3] as folder).data).toEqual(['e'])
        const top = setFolderParent(nested, 'E', null)!
        expect('nodeOnlyParentFolderId' in (top[3] as folder)).toBe(false)
        expect((order[3] as folder).nodeOnlyParentFolderId).toBeUndefined()
    })

    it('refuses a loop, an unknown folder and a no-op', () => {
        expect(setFolderParent(order, 'A', 'C')).toBeNull()
        expect(setFolderParent(order, 'A', 'A')).toBeNull()
        expect(setFolderParent(order, 'nope', 'A')).toBeNull()
        expect(setFolderParent(order, 'B', 'A')).toBeNull()
    })
})

describe('characterOrder with nested folders', () => {
    it('keeps a folder that holds folders even with one or no character', () => {
        const before: OrderEntry[] = [f('P', ['p1', 'p2']), f('K', ['k1', 'k2'], 'P'), f('S', ['s1', 's2'])]
        const after: OrderEntry[] = [f('P', ['p1']), f('K', ['k1', 'k2'], 'P'), f('S', ['s1'])]
        const result = dissolveSingletonFolders(after, before)
        expect(result.map((entry) => (typeof entry === 'string' ? entry : entry.id))).toEqual(['P', 'K', 's1'])

        const emptied: OrderEntry[] = [f('P', []), f('K', ['k1', 'k2'], 'P')]
        expect(dissolveSingletonFolders(emptied, before).map((entry) => (typeof entry === 'string' ? entry : entry.id))).toEqual(['P', 'K'])
    })

    it('moves the folders inside a removed folder up one level', () => {
        const order: OrderEntry[] = [f('G', ['g']), f('P', ['p1', 'p2'], 'G'), f('K', ['k'], 'P'), f('T', ['t'], 'P')]
        const result = removeFolderKeepItems(order, 'P')
        expect(result.filter((entry) => typeof entry === 'string')).toEqual(['p1', 'p2'])
        const byId = new Map(result.filter((entry): entry is folder => typeof entry !== 'string').map((entry) => [entry.id, entry]))
        expect(byId.get('K')?.nodeOnlyParentFolderId).toBe('G')
        expect(byId.get('T')?.nodeOnlyParentFolderId).toBe('G')
        expect(byId.has('P')).toBe(false)

        const top = reparentChildrenOf([f('P', ['p']), f('K', ['k'], 'P')], 'P')
        expect('nodeOnlyParentFolderId' in (top[1] as folder)).toBe(false)
    })
})

describe('folders inside a parent mix with its bots by recency', () => {
    it('puts a folder after the last bot used at least as recently as anything in it', () => {
        // members used at 50, 30, 10; folders newest at 40, 60 and never
        const slots = interleaveFolderSlots([50, 30, 10], [
            { item: 'K40', recency: 40 },
            { item: 'K60', recency: 60 },
            { item: 'K0', recency: 0 },
        ])
        expect(slots).toEqual([['K60'], ['K40'], [], ['K0']])
    })

    it('keeps a bot that was used after the folder above it, wherever it sits', () => {
        // a deactivated (0) bot first, then a recent one: the folder goes below the recent one
        expect(interleaveFolderSlots([0, 90], [{ item: 'K', recency: 50 }])).toEqual([[], [], ['K']])
    })

    it('freezes the open bot at the recency it had before it was opened', () => {
        // a is opened: its stamp counts at once
        const open = railRecencySnapshot([{ chaId: 'a', lastInteraction: 100 }, { chaId: 'b', lastInteraction: 7 }, null, { lastInteraction: 3 }])
        expect([...open]).toEqual([['a', 100], ['b', 7]])
        expect(railRecencySnapshot([{ chaId: 'c', lastInteraction: Number.NaN }, { chaId: 'd' }]).get('c')).toBe(0)
    })

    it('lists the folders a folder is shown in, innermost first', () => {
        const order: OrderEntry[] = [f('A', ['a']), f('B', ['b'], 'A'), f('C', ['c'], 'B')]
        expect(folderAncestors(order, 'C')).toEqual(['B', 'A'])
        expect(folderAncestors(order, 'A')).toEqual([])
    })
})
