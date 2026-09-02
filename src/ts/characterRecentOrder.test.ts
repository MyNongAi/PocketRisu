import { describe, expect, it } from 'vitest'
import type { folder } from './storage/database.svelte'
import { promoteDepartedCharacter, promoteNewlyImportedCharacter, promoteRecentlyViewedCharacter } from './characterRecentOrder'

function makeFolder(id: string, data: string[]): folder {
    return { id, name: id, color: '', data }
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
