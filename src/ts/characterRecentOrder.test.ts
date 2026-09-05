import { describe, expect, it } from 'vitest'
import type { folder } from './storage/database.svelte'
import {
    normalizeCharacterFavoriteOrder,
    promoteCharacterFolder,
    promoteDepartedCharacter,
    promoteNewlyImportedCharacter,
    promoteRecentlyViewedCharacter,
} from './characterRecentOrder'

function makeFolder(id: string, data: string[], favorite = false): folder {
    return { id, name: id, color: '', data, favorite }
}

describe('promoteRecentlyViewedCharacter', () => {
    it('moves a standalone character to the front', () => {
        const order = ['a', 'b', 'c']
        const promoted = promoteRecentlyViewedCharacter(order, 'c')

        expect(promoted).toEqual(['c', 'a', 'b'])
        expect(order).toEqual(['a', 'b', 'c'])
    })

    it('moves a folder character and its folder to the front', () => {
        const bots = makeFolder('bots', ['a', 'b', 'c'])
        const order = ['standalone', bots, 'tail']
        const promoted = promoteRecentlyViewedCharacter(order, 'c')

        expect(promoted).toEqual([
            makeFolder('bots', ['c', 'a', 'b']),
            'standalone',
            'tail',
        ])
        expect(order).toEqual(['standalone', makeFolder('bots', ['a', 'b', 'c']), 'tail'])
        expect(promoted[0]).not.toBe(bots)
    })

    it('keeps the existing reference when the character is already first', () => {
        const standalone = ['a', 'b']
        const folderFirst = [makeFolder('bots', ['a', 'b']), 'tail']

        expect(promoteRecentlyViewedCharacter(standalone, 'a')).toBe(standalone)
        expect(promoteRecentlyViewedCharacter(folderFirst, 'a')).toBe(folderFirst)
    })

    it('does not disturb the order when the character is missing', () => {
        const order = ['a', makeFolder('bots', ['b'])]
        expect(promoteRecentlyViewedCharacter(order, 'missing')).toBe(order)
    })
})

describe('promoteDepartedCharacter', () => {
    it('promotes only the character being left', () => {
        expect(promoteDepartedCharacter(['a', 'b', 'c'], 'c', 'b')).toEqual(['c', 'a', 'b'])
    })

    it('does not move a character when it is selected again', () => {
        const order = ['a', 'b']
        expect(promoteDepartedCharacter(order, 'b', 'b')).toBe(order)
    })

    it('moves the departed character folder as one block', () => {
        const order = ['a', { id: 'f', name: 'Folder', color: '', data: ['b', 'c'] }]
        expect(promoteDepartedCharacter(order, 'c')).toEqual([
            { id: 'f', name: 'Folder', color: '', data: ['c', 'b'] },
            'a',
        ])
    })
})

describe('promoteNewlyImportedCharacter', () => {
    it('inserts a newly imported character at the front', () => {
        const order = ['a', makeFolder('bots', ['b']), 'c']
        const promoted = promoteNewlyImportedCharacter(order, 'new')

        expect(promoted).toEqual(['new', 'a', makeFolder('bots', ['b']), 'c'])
        expect(order).toEqual(['a', makeFolder('bots', ['b']), 'c'])
    })

    it('uses the existing folder-aware promotion when the character is already ordered', () => {
        const order = ['standalone', makeFolder('bots', ['a', 'b'])]
        expect(promoteNewlyImportedCharacter(order, 'b')).toEqual([
            makeFolder('bots', ['b', 'a']),
            'standalone',
        ])
    })

    it('does not insert runtime-only characters', () => {
        const order = ['a']
        expect(promoteNewlyImportedCharacter(order, '§temp')).toBe(order)
        expect(promoteNewlyImportedCharacter(order, '§playground')).toBe(order)
    })
})

describe('character favorites', () => {
    it('keeps favorite characters and their folders in a stable top section', () => {
        const order = ['regular', makeFolder('bots', ['folder-regular', 'folder-favorite']), 'favorite']
        const favorites = new Set(['favorite', 'folder-favorite'])

        expect(normalizeCharacterFavoriteOrder(order, favorites)).toEqual([
            makeFolder('bots', ['folder-favorite', 'folder-regular']),
            'favorite',
            'regular',
        ])
        expect(order).toEqual(['regular', makeFolder('bots', ['folder-regular', 'folder-favorite']), 'favorite'])
    })

    it('moves a regular recently viewed character below favorites', () => {
        const favorites = new Set(['favorite'])
        expect(promoteRecentlyViewedCharacter(['favorite', 'a', 'b'], 'b', favorites)).toEqual([
            'favorite',
            'b',
            'a',
        ])
    })

    it('moves a newly favorited character and its folder to the top', () => {
        const favorites = new Set(['b'])
        expect(promoteRecentlyViewedCharacter(['standalone', makeFolder('bots', ['a', 'b'])], 'b', favorites)).toEqual([
            makeFolder('bots', ['b', 'a']),
            'standalone',
        ])
    })

    it('moves a favorite folder to the top without flattening it', () => {
        const order = ['a', makeFolder('bots', ['b'], true), 'c']
        expect(promoteCharacterFolder(order, 'bots')).toEqual([
            makeFolder('bots', ['b'], true),
            'a',
            'c',
        ])
    })

    it('places imports below the favorite section', () => {
        const favorites = new Set(['favorite'])
        expect(promoteNewlyImportedCharacter(['favorite', 'a'], 'new', favorites)).toEqual([
            'favorite',
            'new',
            'a',
        ])
    })
})
