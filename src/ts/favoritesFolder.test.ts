import { describe, expect, it } from 'vitest'
import type { folder } from './storage/database.svelte'
import { FAVORITES_FOLDER_ID, gatherFavoritesFolder, isFavoritesFolder, syncFavoritesWithFolderMoves } from './favoritesFolder'

const on = { enabled: true, name: '즐겨찾기' }
const userFolder = (id: string, data: string[]): folder => ({ id, name: id, color: '', data })
const favFolder = (data: string[]): folder => ({ id: FAVORITES_FOLDER_ID, name: '즐겨찾기', color: 'yellow', data, nodeOnlySystem: 'favorites', nodeOnlyIcon: 'star', nodeOnlyDisplay: 'icon' })

describe('gatherFavoritesFolder', () => {
    it('gathers loose favorites into a star folder at the top', () => {
        const next = gatherFavoritesFolder(['a', 'f1', userFolder('u', ['f2', 'b']), 'f3'], new Set(['f1', 'f2', 'f3']), on)
        expect(next[0]).toEqual(favFolder(['f1', 'f3']))
        // A favorite inside a folder the user made stays there.
        expect(next.slice(1)).toEqual(['a', userFolder('u', ['f2', 'b'])])
    })

    it('puts a new favorite first and releases an unfavorited member to the top of the list', () => {
        const order = [favFolder(['f1', 'old']), 'a', 'new']
        expect(gatherFavoritesFolder(order, new Set(['f1', 'new']), on)).toEqual([favFolder(['new', 'f1']), 'old', 'a'])
    })

    it('removes the folder when the last favorite leaves', () => {
        expect(gatherFavoritesFolder([favFolder(['x']), 'a'], new Set(), on)).toEqual(['x', 'a'])
        expect(gatherFavoritesFolder(['a', 'b'], new Set(), on)).toEqual(['a', 'b'])
    })

    it('keeps the name and colour the user gave it', () => {
        const renamed = { ...favFolder(['f']), name: '최애', color: 'pink' }
        const next = gatherFavoritesFolder(['g', renamed], new Set(['f', 'g']), on)
        expect(next[0]).toMatchObject({ name: '최애', color: 'pink', data: ['g', 'f'] })
    })

    it('when turned off, puts the members back where the folder was', () => {
        expect(gatherFavoritesFolder(['a', favFolder(['f1', 'f2']), 'b'], new Set(['f1', 'f2']), { ...on, enabled: false }))
            .toEqual(['a', 'f1', 'f2', 'b'])
    })

    it('recognises the folder by id or marker', () => {
        expect(isFavoritesFolder(favFolder([]))).toBe(true)
        expect(isFavoritesFolder({ ...userFolder('x', []), nodeOnlySystem: 'favorites' })).toBe(true)
        expect(isFavoritesFolder(userFolder('x', []))).toBe(false)
        expect(isFavoritesFolder('a')).toBe(false)
    })
})

describe('syncFavoritesWithFolderMoves', () => {
    it('favorites what is dragged in and unfavorites what is dragged out', () => {
        const characters = [{ chaId: 'in', favorite: false }, { chaId: 'out', favorite: true }, { chaId: 'stay', favorite: true }]
        const previous = [favFolder(['out', 'stay']), 'in']
        const next = [favFolder(['stay', 'in']), 'out']
        expect(syncFavoritesWithFolderMoves(previous, next, characters)).toBe(true)
        expect(characters.map((c) => c.favorite)).toEqual([true, false, true])
    })

    it('leaves a character that was removed from the list alone', () => {
        const characters = [{ chaId: 'gone', favorite: true }]
        expect(syncFavoritesWithFolderMoves([favFolder(['gone'])], [], characters)).toBe(false)
        expect(characters[0].favorite).toBe(true)
    })
})
