import { describe, expect, it } from 'vitest'
import { favoriteAfterMove, gatherFavoriteModules, MODULE_FAVORITES_FOLDER_NAME } from './moduleFavoritesFolder'
import { dissolveShrunkenModuleFolders } from './moduleFolders'

const ids = () => {
    let n = 0
    return () => `new-${++n}`
}

describe('the ★ folder of favorite modules', () => {
    it('gathers loose favorites into a new ★ folder at the top, leaving favorites in folders where they are', () => {
        const modules = [
            { id: 'a', name: 'A', favorite: true },
            { id: 'b', name: 'B' },
            { id: 'c', name: 'C', favorite: true, folderId: 'mine' },
            { id: 'd', name: 'D', favorite: true, folderId: 'gone' },
        ]
        const result = gatherFavoriteModules(modules, [{ id: 'mine', name: 'Mine', moduleIds: ['c'], sortOrder: 0 }], ids())
        expect(result?.folders[0]).toMatchObject({
            id: 'new-1', name: MODULE_FAVORITES_FOLDER_NAME, moduleIds: ['a', 'd'],
            favorite: true, nodeOnlyFavoritesFolder: true, sortOrder: -1,
        })
        expect(result?.modules.map((module) => module.folderId)).toEqual(['new-1', undefined, 'mine', 'new-1'])
        // Unchanged modules stay the same objects (the save tracker).
        expect(result?.modules[1]).toBe(modules[1])
        expect(result?.modules[2]).toBe(modules[2])
        expect(gatherFavoriteModules(result!.modules, result!.folders, ids())).toBeNull()
    })

    it('lets an unfavorited module out, and the emptied ★ folder goes', () => {
        const folders = [{ id: 'star', name: '즐겨찾기', moduleIds: ['a', 'b'], favorite: true, nodeOnlyFavoritesFolder: true }]
        const one = gatherFavoriteModules([
            { id: 'a', name: 'A', folderId: 'star', favorite: true },
            { id: 'b', name: 'B', folderId: 'star' },
        ], folders, ids())
        expect(one?.modules.map((module) => module.folderId)).toEqual(['star', undefined])
        expect(one?.folders).toEqual([{ ...folders[0], moduleIds: ['a'] }])

        const none = gatherFavoriteModules([{ id: 'a', name: 'A', folderId: 'star' }], folders, ids())
        expect(none?.modules[0].folderId).toBeUndefined()
        expect(none?.folders).toEqual([])
    })

    it('keeps the ★ folder at one favorite', () => {
        const before = [{ id: 'star', name: '즐겨찾기', moduleIds: ['a', 'b'], nodeOnlyFavoritesFolder: true }]
        const after = [{ id: 'star', name: '즐겨찾기', moduleIds: ['a'], nodeOnlyFavoritesFolder: true }]
        const modules = [{ id: 'a', name: 'A', folderId: 'star' }, { id: 'b', name: 'B' }]
        expect(dissolveShrunkenModuleFolders(modules, after, before).folders.map((folder) => folder.id)).toEqual(['star'])
    })

    it('favorites a module moved in and unfavorites one moved out', () => {
        expect(favoriteAfterMove(false, undefined, 'star', 'star')).toBe(true)
        expect(favoriteAfterMove(false, 'mine', 'star', 'star')).toBe(true)
        expect(favoriteAfterMove(true, 'star', undefined, 'star')).toBe(false)
        expect(favoriteAfterMove(true, 'star', 'mine', 'star')).toBe(false)
        expect(favoriteAfterMove(true, 'mine', undefined, 'star')).toBe(true)
        expect(favoriteAfterMove(true, 'star', 'star', 'star')).toBe(true)
        expect(favoriteAfterMove(false, undefined, 'mine', undefined)).toBe(false)
    })
})
