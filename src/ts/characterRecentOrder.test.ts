import { describe, expect, it } from 'vitest'
import type { folder } from './storage/database.svelte'
import { promoteRecentlyViewedCharacter } from './characterRecentOrder'

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
