import { describe, it, expect } from 'vitest'
import {
    rebuildOrder,
    moveCharacterToFolder,
    moveTopLevelEntry,
    moveCharacterInFolder,
    createFolder,
    updateFolder,
    removeFolderKeepItems,
    removeCharacter,
    findPlacement,
    setHidden,
    pruneHiddenCharacterIds,
    dissolveSingletonFolders,
    type OrderEntry,
} from './characterOrder'

function sample(): OrderEntry[] {
    return [
        'a',
        { id: 'f1', name: 'One', color: 'red', imgFile: 'img1', img: 'blob:1', data: ['b', 'c'] },
        'd',
        { id: 'f2', name: 'Two', color: '', data: [] },
    ]
}

function snapshot(order: OrderEntry[]) {
    return JSON.stringify(order)
}

describe('characterOrder', () => {
    it('rebuildOrder keeps occupied folder fields, drops empty/unknown folders, dedupes and re-appends missing characters', () => {
        const before = sample()
        const frozen = snapshot(before)
        const next = rebuildOrder(before, [
            { type: 'folder', id: 'f2', data: ['d', 'a'] },
            { type: 'char', id: 'c' },
            { type: 'char', id: 'c' },
            { type: 'folder', id: 'ghost', data: ['b'] },
            { type: 'folder', id: 'f1', data: [] },
        ])
        expect(next).toEqual([
            { id: 'f2', name: 'Two', color: '', data: ['d', 'a'] },
            'c',
            'b',
        ])
        expect(snapshot(before)).toBe(frozen)
    })

    it('rebuildOrder keeps empty folders', () => {
        const next = rebuildOrder(sample(), [
            { type: 'folder', id: 'f2', data: [] },
            { type: 'char', id: 'a' },
            { type: 'folder', id: 'f1', data: ['b', 'c'] },
            { type: 'char', id: 'd' },
        ])
        expect(next[0]).toEqual({ id: 'f2', name: 'Two', color: '', data: [] })
    })

    it('moveCharacterToFolder appends to the folder and removes the old placement', () => {
        const before = sample()
        const frozen = snapshot(before)
        const next = moveCharacterToFolder(before, 'a', 'f1')
        expect(next).toEqual([
            { id: 'f1', name: 'One', color: 'red', imgFile: 'img1', img: 'blob:1', data: ['b', 'c', 'a'] },
            'd',
            { id: 'f2', name: 'Two', color: '', data: [] },
        ])
        expect(snapshot(before)).toBe(frozen)
        expect(findPlacement(next, 'a')).toEqual({ chaId: 'a', folderId: 'f1' })
    })

    it('moveCharacterToFolder(undefined) moves out to the top level; unknown folder is a no-op', () => {
        const out = moveCharacterToFolder(sample(), 'b', undefined)
        expect(out).toEqual([
            'a',
            'c',
            'd',
            { id: 'f2', name: 'Two', color: '', data: [] },
            'b',
        ])
        expect(moveCharacterToFolder(sample(), 'b', 'nope')).toEqual(sample())
    })

    it('moveTopLevelEntry moves characters and folders, clamped at the edges', () => {
        expect(moveTopLevelEntry(sample(), 'a', -1)).toEqual(sample())
        const next = moveTopLevelEntry(sample(), 'f1', -1)
        expect(next[0]).toMatchObject({ id: 'f1' })
        expect(next[1]).toBe('a')
        expect(moveTopLevelEntry(sample(), 'f2', 1)).toEqual(sample())
    })

    it('moveCharacterInFolder reorders inside the folder only', () => {
        const next = moveCharacterInFolder(sample(), 'f1', 'c', -1)
        expect(next[1]).toMatchObject({ id: 'f1', data: ['c', 'b'] })
        expect(moveCharacterInFolder(sample(), 'f1', 'b', -1)).toEqual(sample())
    })

    it('createFolder / updateFolder / removeFolderKeepItems', () => {
        const created = createFolder(sample(), 'f3', 'Three')
        expect(created[4]).toEqual({ id: 'f3', name: 'Three', data: [], color: '' })

        const updated = updateFolder(sample(), 'f1', { name: 'Renamed', color: 'blue' })
        expect(updated[1]).toEqual({ id: 'f1', name: 'Renamed', color: 'blue', imgFile: 'img1', img: 'blob:1', data: ['b', 'c'] })
        expect(updateFolder(sample(), 'nope', { name: 'x' })).toEqual(sample())

        const removed = removeFolderKeepItems(sample(), 'f1')
        expect(removed).toEqual(['a', 'b', 'c', 'd', { id: 'f2', name: 'Two', color: '', data: [] }])
    })

    it('removeCharacter strips every occurrence', () => {
        const order: OrderEntry[] = ['a', { id: 'f', name: 'F', color: '', data: ['a', 'b'] }, 'a']
        expect(removeCharacter(order, 'a')).toEqual(['b'])
    })

    it('removes a folder when its last character is removed', () => {
        const order: OrderEntry[] = [
            'a',
            { id: 'only', name: 'Only', color: '', data: ['b'] },
            'c',
        ]
        expect(removeCharacter(order, 'b')).toEqual(['a', 'c'])
    })

    it('dissolves every singleton folder in place and keeps empty folders', () => {
        const order: OrderEntry[] = [
            { id: 'first', name: 'First', color: '', data: ['b'] },
            { id: 'second', name: 'Second', color: '', data: ['c'] },
            { id: 'empty', name: 'Empty', color: '', data: [] },
        ]
        expect(dissolveSingletonFolders(order)).toEqual([
            'b',
            'c',
            { id: 'empty', name: 'Empty', color: '', data: [] },
        ])
    })

    it('keeps an intentionally empty folder but removes one that just lost its members', () => {
        const empty: OrderEntry = { id: 'empty', name: 'Empty', color: '', data: [] }
        const formerlyOccupied: OrderEntry = { id: 'lost', name: 'Lost', color: '', data: ['a'] }
        expect(dissolveSingletonFolders([empty], [empty])).toEqual([empty])
        expect(dissolveSingletonFolders([
            { ...formerlyOccupied, data: [] },
        ], [formerlyOccupied])).toEqual([])
    })

    it('setHidden adds/removes without duplicates; prune keeps only known ids', () => {
        expect(setHidden(['a'], ['a', 'b'], true)).toEqual(['a', 'b'])
        expect(setHidden(['a', 'b'], ['a'], false)).toEqual(['b'])
        expect(pruneHiddenCharacterIds(['a', 'a', 'zz', 3 as unknown as string], new Set(['a']))).toEqual(['a'])
    })
})
