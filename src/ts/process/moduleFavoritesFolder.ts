import {
    normalizeModuleFolders,
    synchronizeModuleFolderMembership,
    type FolderableModule,
    type ModuleFolder,
} from './moduleFolders'

// The ★ folder of the module catalog (the user's request, 2026-10-30:
// "즐찾도 폴더가 있는게 낫겠다"), as on the bot list (favoritesFolder.ts):
// favorite modules outside a folder gather in one folder at the very top of
// both module lists. Favoriting a loose module moves it in, unfavoriting moves
// it out to the top level, and a move into or out of the folder (a drag, the
// folder menu, deleting the folder) sets or clears the flag
// (favoriteAfterMove). A favorite in a folder of the user's or in [링크]/[프롬]
// stays there. The folder goes when nothing is in it.

export const MODULE_FAVORITES_FOLDER_NAME = '즐겨찾기'

type FavoriteModule = FolderableModule & { favorite?: boolean }

export function isModuleFavoritesFolder(folder: { nodeOnlyFavoritesFolder?: boolean } | null | undefined): boolean {
    return !!folder?.nodeOnlyFavoritesFolder
}

/** The favorite flag after a module moved from one folder to another. */
export function favoriteAfterMove(favorite: boolean, fromFolderId: string | undefined, toFolderId: string | undefined, favoritesFolderId: string | undefined): boolean {
    if (!favoritesFolderId || fromFolderId === toFolderId) return favorite
    if (toFolderId === favoritesFolderId) return true
    if (fromFolderId === favoritesFolderId) return false
    return favorite
}

/**
 * The catalog after gathering, or null when nothing changes. A moved module is
 * a new object, so the save tracker sees only those.
 */
export function gatherFavoriteModules<T extends FavoriteModule>(
    modules: readonly T[],
    folders: unknown,
    createId: () => string,
): { modules: T[], folders: ModuleFolder[] } | null {
    const current = normalizeModuleFolders(folders)
    const existing = current.find(isModuleFavoritesFolder)
    const folderIds = new Set(current.map((folder) => folder.id))
    let favoritesId = existing?.id ?? ''
    let changed = false

    const nextModules = modules.map((module) => {
        const folderId = module.folderId && folderIds.has(module.folderId) ? module.folderId : undefined
        if (module.favorite && !folderId) {
            changed = true
            return { ...module, folderId: (favoritesId ||= createId()) }
        }
        if (!module.favorite && existing && folderId === existing.id) {
            changed = true
            return { ...module, folderId: undefined }
        }
        return module
    })

    let nextFolders = current
    const used = !!favoritesId && (nextModules.some((module) => module.folderId === favoritesId)
        || current.some((folder) => folder.nodeOnlyParentFolderId === favoritesId))
    if (!existing && used) {
        const explicitOrders = current.map((folder) => folder.sortOrder).filter((order): order is number => Number.isFinite(order))
        const folder: ModuleFolder = {
            id: favoritesId,
            name: MODULE_FAVORITES_FOLDER_NAME,
            moduleIds: [],
            favorite: true,
            nodeOnlyFavoritesFolder: true,
            // Folders ordered by hand or by activation keep a sortOrder; a new
            // one without would sink to the bottom.
            ...(explicitOrders.length > 0 ? { sortOrder: Math.min(...explicitOrders) - 1 } : {}),
        }
        nextFolders = [folder, ...current]
        changed = true
    } else if (existing && !used) {
        nextFolders = current.filter((folder) => folder.id !== existing.id)
        changed = true
    } else if (existing && !existing.favorite) {
        // Drawn with the star and held at the top as a favorite folder.
        nextFolders = current.map((folder) => folder === existing ? { ...folder, favorite: true } : folder)
        changed = true
    }
    if (!changed) return null

    // No folder of the user's loses a module here, so none dissolves.
    return {
        modules: nextModules,
        folders: synchronizeModuleFolderMembership(nextModules, nextFolders, { importLegacyWhenFolderIdsEmpty: false }),
    }
}
