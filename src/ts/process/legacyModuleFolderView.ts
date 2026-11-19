import type { PromptPresetFolder } from '../storage/database.svelte'
import type { ModuleCatalogDisplayBlock, ModuleCatalogDisplayGroup, ModuleSortOptions, SortableModule } from './moduleSort'

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

// LEGACY-MODULE-FOLDERS: September's favorite-first recent sort.
export function sortLegacyModulesByActivation<T extends SortableModule>(
    modules: ReadonlyArray<T>, search: string, options: ModuleSortOptions = {},
): T[] {
    const normalizedSearch = search.trim().toLocaleLowerCase()
    const merged: string[] = []
    for (const order of [...options.fallbackOrders ?? [], options.activationHistory]) {
        for (const id of order ?? []) {
            const oldIndex = merged.indexOf(id)
            if (oldIndex !== -1) merged.splice(oldIndex, 1)
            merged.push(id)
        }
    }
    const recencyRank = new Map(merged.map((id, index) => [id, index]))
    return modules.filter((module) => !normalizedSearch || module.name.toLocaleLowerCase().includes(normalizedSearch)).sort((a, b) => {
        const favoriteOrder = Number(!!b.favorite) - Number(!!a.favorite)
        if (favoriteOrder) return favoriteOrder
        const aRank = recencyRank.get(a.id)
        const bRank = recencyRank.get(b.id)
        if (aRank !== undefined && bRank === undefined) return -1
        if (aRank === undefined && bRank !== undefined) return 1
        if (aRank !== undefined && bRank !== undefined && aRank !== bRank) return bRank - aRank
        return a.name.localeCompare(b.name)
    })
}

// LEGACY-MODULE-FOLDERS: September's promoted entry, favorite folders, empty folders, then first-member order.
export function interleaveLegacyModuleCatalogGroups(
    groups: ReadonlyArray<ModuleCatalogDisplayGroup>, promotedRootIndex = -1, promotedFolderId = '',
): ModuleCatalogDisplayBlock[] {
    const folders = groups.filter((group) => !!group.folder)
    const root = groups.find((group) => !group.folder)
    const rootIndexes = new Set(root?.indexes ?? [])
    const folderByIndex = new Map<number, string>()
    for (const group of folders) {
        for (const index of group.indexes) folderByIndex.set(index, group.folder!.id)
    }
    const emittedFolders = new Set<string>()
    const emittedRoot = new Set<number>()
    const result: ModuleCatalogDisplayBlock[] = []
    const emitFolder = (id: string) => {
        if (emittedFolders.has(id)) return
        emittedFolders.add(id)
        result.push({ kind: 'folder', folderId: id })
    }
    const emitRoot = (index: number) => {
        if (emittedRoot.has(index)) return
        emittedRoot.add(index)
        const previous = result.at(-1)
        if (previous?.kind === 'root') previous.indexes.push(index)
        else result.push({ kind: 'root', indexes: [index] })
    }
    if (rootIndexes.has(promotedRootIndex)) emitRoot(promotedRootIndex)
    else if (promotedFolderId && folders.some((group) => group.folder?.id === promotedFolderId)) emitFolder(promotedFolderId)
    for (const group of folders) if (group.folder?.favorite) emitFolder(group.folder.id)
    for (const group of folders) if (group.indexes.length === 0) emitFolder(group.folder!.id)
    const orderedIndexes = [...rootIndexes, ...folderByIndex.keys()].sort((a, b) => a - b)
    for (const index of orderedIndexes) {
        if (rootIndexes.has(index)) emitRoot(index)
        else emitFolder(folderByIndex.get(index)!)
    }
    for (const group of folders) emitFolder(group.folder!.id)
    return result
}

// LEGACY-MODULE-FOLDERS: menu history reads drawn placements; storage restores unchanged hidden memberships.
export function legacyActivationHistoryFromPlacements(
    placements: ReadonlyArray<{ index: number }>, moduleIds: ReadonlyArray<string>,
): string[] {
    return placements.map(({ index }) => moduleIds[index]).filter((id): id is string => !!id).reverse()
}

export function storedLegacyPlacements(
    placements: ReadonlyArray<{ index: number; folderId: string | undefined }>,
    drawnFolderIds: ReadonlyArray<string | undefined>,
    storedFolderIds: ReadonlyArray<string | undefined>,
) {
    return placements.map(({ index, folderId }) => ({
        index,
        folderId: folderId === drawnFolderIds[index] ? storedFolderIds[index] : folderId,
    }))
}
