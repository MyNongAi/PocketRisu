import type { PromptPresetFolder } from '../storage/database.svelte'

interface FolderedModule {
    folderId?: string
}

type CatalogFolder = PromptPresetFolder & { duplicateCandidate?: unknown }

/** LEGACY-MODULE-FOLDERS: derive the September catalog without changing saved membership. */
export function legacyModuleFolderView(
    modules: readonly FolderedModule[],
    moduleFolders: readonly CatalogFolder[],
): { folders: PromptPresetFolder[]; itemFolderIds: (string | undefined)[] } {
    const byId = new Map(moduleFolders.map((folder) => [folder.id, folder]))
    const isLinkDescendant = (folder: CatalogFolder): boolean => {
        const seen = new Set<string>([folder.id])
        let parentId = folder.nodeOnlyParentFolderId
        while (parentId && !seen.has(parentId)) {
            seen.add(parentId)
            const parent = byId.get(parentId)
            if (!parent) break
            if (parent.nodeOnlyLinkFolder) return true
            parentId = parent.nodeOnlyParentFolderId
        }
        return false
    }
    const folders = moduleFolders
        .filter((folder) => !folder.nodeOnlyLinkFolder
            && !folder.nodeOnlyPresetFolder
            && !folder.nodeOnlyFavoritesFolder
            && !(folder.duplicateCandidate && isLinkDescendant(folder)))
        .map((folder) => {
            const { nodeOnlyParentFolderId: _parent, ...drawn } = folder
            return drawn
        })
    const visibleIds = new Set(folders.map((folder) => folder.id))
    return {
        folders,
        itemFolderIds: modules.map((module) => module.folderId && visibleIds.has(module.folderId) ? module.folderId : undefined),
    }
}
