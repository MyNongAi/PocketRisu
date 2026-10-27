export interface SortableModule {
    id: string
    name: string
    folderId?: string
    favorite?: boolean
}

export interface SortableModuleFolder {
    id: string
    moduleIds?: ReadonlyArray<string>
    favorite?: boolean
    /** Explicit visual order; never reorders the source module array. */
    sortOrder?: number
}

export interface ModuleSortOptions {
    fallbackOrders?: Array<ReadonlyArray<string> | undefined>
    activationHistory?: ReadonlyArray<string>
}

function mergeActivationOrders(orders: ReadonlyArray<ReadonlyArray<string> | undefined>) {
    const merged: string[] = []

    for(const order of orders){
        for(const id of order ?? []){
            const oldIndex = merged.indexOf(id)
            if(oldIndex !== -1){
                merged.splice(oldIndex, 1)
            }
            merged.push(id)
        }
    }

    return merged
}

export function sortModulesByActivation<T extends SortableModule>(
    modules: ReadonlyArray<T>,
    search: string,
    options: ModuleSortOptions = {},
): T[] {
    const normalizedSearch = search.trim().toLocaleLowerCase()
    const recencyOrder = mergeActivationOrders([
        ...options.fallbackOrders ?? [],
        options.activationHistory,
    ])
    const recencyRank = new Map(recencyOrder.map((id, index) => [id, index]))

    return modules.filter((module) => {
        if(normalizedSearch === '') return true
        return module.name.toLocaleLowerCase().includes(normalizedSearch)
    }).sort((a, b) => {
        // Recency only: favorites hold the top in the catalog's blocks
        // (interleaveModuleCatalogGroups), so a drag among them stays.
        const aRank = recencyRank.get(a.id)
        const bRank = recencyRank.get(b.id)

        if(aRank !== undefined && bRank === undefined){
            return -1
        }
        if(aRank === undefined && bRank !== undefined){
            return 1
        }
        if(aRank !== undefined && bRank !== undefined && aRank !== bRank){
            return bRank - aRank
        }
        return a.name.localeCompare(b.name)
    })
}

/**
 * The recency order with the given modules moved to the newest end, keeping
 * their own order among them: a folder's modules when it is favorited, the
 * favorites once (liftFavoritesOnce). Modules on now are no longer lifted
 * on screen (the user's rule, 2026-10-27: only favorites hold the top).
 */
export function liftModulesToNewest(
    history: ReadonlyArray<string> | undefined,
    fallbackOrders: Array<ReadonlyArray<string> | undefined>,
    liftedIds: ReadonlyArray<string>,
): string[] {
    const order = mergeActivationOrders([...fallbackOrders, history])
    if (liftedIds.length === 0) return order
    const rank = new Map(order.map((id, index) => [id, index]))
    const lifted = [...new Set(liftedIds)].sort((a, b) => (rank.get(a) ?? -1) - (rank.get(b) ?? -1))
    return mergeActivationOrders([order, lifted])
}

export function seedModuleActivationHistory(
    history: ReadonlyArray<string> | undefined,
    ...fallbackOrders: Array<ReadonlyArray<string> | undefined>
): string[] {
    return mergeActivationOrders([
        ...fallbackOrders,
        history,
    ])
}

export function recordModuleActivation(
    history: ReadonlyArray<string> | undefined,
    moduleId: string,
): string[] {
    return [
        ...(history ?? []).filter((id) => id !== moduleId),
        moduleId,
    ]
}

export interface ModuleCatalogPromotion {
    moduleId: string
    folderId?: string
}

export interface ModuleCatalogDisplayGroup {
    folder: { id: string; favorite?: boolean } | null
    indexes: ReadonlyArray<number>
    /** Items in the folders shown inside this one: they place it too. */
    nestedIndexes?: ReadonlyArray<number>
}

export type ModuleCatalogDisplayBlock =
    | { kind: 'folder'; folderId: string }
    | { kind: 'root'; indexes: number[] }

/** Keep standalone modules and folders interleaved at the first visible member.
 * Promoting one entry must never hoist every other folder as a block. */
export function interleaveModuleCatalogGroups(
    groups: ReadonlyArray<ModuleCatalogDisplayGroup>,
    promotedRootIndex = -1,
    promotedFolderId = '',
    favoriteRootIndexes: ReadonlySet<number> = new Set(),
): ModuleCatalogDisplayBlock[] {
    const folders = groups.filter((group) => !!group.folder)
    const root = groups.find((group) => !group.folder)
    const rootIndexes = new Set(root?.indexes ?? [])
    const folderByIndex = new Map<number, string>()
    for (const group of folders) {
        for (const index of [...group.indexes, ...group.nestedIndexes ?? []]) {
            if (!rootIndexes.has(index) && !folderByIndex.has(index)) folderByIndex.set(index, group.folder!.id)
        }
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

    const orderedIndexes = [...rootIndexes, ...folderByIndex.keys()].sort((a, b) => a - b)
    // Only favorites hold the top (the user's rule, 2026-10-27: "즐찾만
    // 고정"): ★ modules outside folders and ★ folders, among themselves in
    // the order of their items, so a drag between them stays. Modules on
    // now, [링크]·[프롬] and 🎨 follow the order like any other.
    const favoriteFolderIds = new Set(folders.filter((group) => group.folder?.favorite).map((group) => group.folder!.id))
    for (const index of orderedIndexes) {
        if (rootIndexes.has(index)) {
            if (favoriteRootIndexes.has(index)) emitRoot(index)
        } else if (favoriteFolderIds.has(folderByIndex.get(index)!)) {
            emitFolder(folderByIndex.get(index)!)
        }
    }
    for (const id of favoriteFolderIds) emitFolder(id)

    if (rootIndexes.has(promotedRootIndex)) emitRoot(promotedRootIndex)
    else if (promotedFolderId && folders.some((group) => group.folder?.id === promotedFolderId)) emitFolder(promotedFolderId)

    // A newly made empty folder shows under the favorites. A folder holding
    // only folders (as [프롬] does) is placed by the newest item in them.
    for (const group of folders) if (group.indexes.length === 0 && !group.nestedIndexes?.length) emitFolder(group.folder!.id)

    for (const index of orderedIndexes) {
        if (rootIndexes.has(index)) emitRoot(index)
        else emitFolder(folderByIndex.get(index)!)
    }
    for (const group of folders) emitFolder(group.folder!.id)
    return result
}

/** Resolve the one concrete top-level catalog entry for the newest activation. */
export function getLatestModuleCatalogPromotion(
    modules: ReadonlyArray<SortableModule>,
    folders: ReadonlyArray<SortableModuleFolder>,
    options: ModuleSortOptions = {},
): ModuleCatalogPromotion | undefined {
    const recencyOrder = mergeActivationOrders([
        ...options.fallbackOrders ?? [],
        options.activationHistory,
    ])
    const moduleById = new Map(modules.map((module) => [module.id, module]))

    for(let index = recencyOrder.length - 1; index >= 0; index--){
        const module = moduleById.get(recencyOrder[index])
        if(!module) continue
        const folderId = module.folderId
            || folders.find((folder) => folder.moduleIds?.includes(module.id))?.id
        return { moduleId: module.id, folderId: folderId || undefined }
    }

    return undefined
}

/** @deprecated Prefer the concrete promoted entry over moving an entire block. */
export function shouldRootModulesLeadByActivation(
    modules: ReadonlyArray<SortableModule>,
    folders: ReadonlyArray<SortableModuleFolder>,
    options: ModuleSortOptions = {},
    fallback = true,
): boolean {
    const promoted = getLatestModuleCatalogPromotion(modules, folders, options)
    return promoted ? !promoted.folderId : fallback
}

/**
 * Adds newly created/imported modules to the same newest-first catalog used by
 * module activation. The stored history remains oldest -> newest.
 */
export function recordNewModules(
    history: ReadonlyArray<string> | undefined,
    fallbackOrders: Array<ReadonlyArray<string> | undefined>,
    moduleIds: ReadonlyArray<string>,
): string[] {
    let next = seedModuleActivationHistory(history, ...fallbackOrders)
    for(const moduleId of moduleIds){
        if(!moduleId) continue
        next = recordModuleActivation(next, moduleId)
    }
    return next
}

/**
 * Sorts only the catalog's folder overlay. The module array itself is never
 * reordered: a folder whose newest member was activated most recently floats
 * to the top, while inactive folders retain their manual relative order.
 */
export function sortModuleFoldersByActivation<T extends SortableModuleFolder>(
    folders: ReadonlyArray<T>,
    modules: ReadonlyArray<SortableModule>,
    options: ModuleSortOptions = {},
): T[] {
    const recencyOrder = mergeActivationOrders([
        ...options.fallbackOrders ?? [],
        options.activationHistory,
    ])
    const recencyRank = new Map(recencyOrder.map((id, index) => [id, index]))
    const membersByFolder = new Map<string, Set<string>>()
    const hasExplicitOrder = folders.some((folder) => Number.isFinite(folder.sortOrder))

    for(const folder of folders){
        membersByFolder.set(folder.id, new Set(folder.moduleIds ?? []))
    }
    for(const module of modules){
        if(module.folderId && membersByFolder.has(module.folderId)){
            membersByFolder.get(module.folderId)!.add(module.id)
        }
    }

    return folders
        .map((folder, index) => {
            let rank = -1
            for(const moduleId of membersByFolder.get(folder.id) ?? []){
                rank = Math.max(rank, recencyRank.get(moduleId) ?? -1)
            }
            return { folder, index, rank }
        })
        .sort((a, b) => {
            const aOrder = Number.isFinite(a.folder.sortOrder) ? a.folder.sortOrder! : undefined
            const bOrder = Number.isFinite(b.folder.sortOrder) ? b.folder.sortOrder! : undefined
            if (hasExplicitOrder) return (aOrder ?? Infinity) - (bOrder ?? Infinity) || a.index - b.index
            return b.rank - a.rank || a.index - b.index
        })
        .map(({ folder }) => folder)
}

/** One catalog row: a module and its group (folder id; undefined at the top level). */
export interface PlacedModule {
    id: string
    folderId?: string
}

/**
 * The activation history after the catalog's modules were placed in 최근순
 * (dragged, moved up or down, moved to a folder, or their folder deleted).
 * There the list order is the recency, so only a reorder among modules that
 * stayed in the same group changes it: those modules trade their recency
 * slots, and every other module keeps its own. A module that only changed
 * folder keeps its recency. It used to rewrite the whole history in the
 * list's folders-first order, which lifted every folder above the loose
 * modules whenever a folder was deleted or a module moved (2026-10-05).
 * `before`/`after`: the modules in display order (newest first).
 */
export function activationHistoryAfterPlacement(
    before: ReadonlyArray<PlacedModule>,
    after: ReadonlyArray<PlacedModule>,
    history: ReadonlyArray<string>,
    fallbackOrders: Array<ReadonlyArray<string> | undefined> = [],
): string[] {
    const oldGroup = new Map(before.map((item) => [item.id, item.folderId ?? '']))
    const shownAt = new Map(before.map((item, index) => [item.id, index]))
    const stayers = new Map<string, string[]>()
    for (const item of after) {
        const group = item.folderId ?? ''
        if (!oldGroup.has(item.id) || oldGroup.get(item.id) !== group) continue
        stayers.set(group, [...(stayers.get(group) ?? []), item.id])
    }
    const reordered = [...stayers.values()].filter((ids) => ids.some((id, i) => i > 0 && shownAt.get(ids[i - 1])! > shownAt.get(id)!))
    if (reordered.length === 0) return [...history]

    // Recency, oldest first, as the catalog sorts it. Modules it has none for
    // join at the old end, in the order shown, so they can take a slot too.
    let order = mergeActivationOrders([...fallbackOrders, history])
    const missing = reordered.flat().filter((id) => !order.includes(id))
        .sort((a, b) => shownAt.get(b)! - shownAt.get(a)!)
    order = [...missing, ...order]
    for (const ids of reordered) {
        const slots = ids.map((id) => order.indexOf(id)).sort((a, b) => b - a)
        ids.forEach((id, k) => { order[slots[k]] = id })
    }
    return order
}

/**
 * The activation history after a drag in 최근순: the catalog as the drop left
 * it on screen (`shownNewestFirst`, every row top to bottom, folders and
 * the folders in them included) becomes the recency, so the next render
 * shows exactly that and the dragged module or folder stays where it was
 * put (the user's request, 2026-10-26). Ids not shown keep their place
 * below. Only for a drop: a menu edit has no screen order to read (see
 * activationHistoryAfterPlacement).
 */
export function activationHistoryFromDisplay(
    shownNewestFirst: ReadonlyArray<string>,
    history: ReadonlyArray<string> | undefined,
    fallbackOrders: Array<ReadonlyArray<string> | undefined> = [],
): string[] {
    const shown = new Set(shownNewestFirst)
    const rest = mergeActivationOrders([...fallbackOrders, history]).filter((id) => !shown.has(id))
    return [...rest, ...[...shown].reverse()]
}

/**
 * Favorites used to hold the top of 최근순. Once, when that stopped, they are
 * lifted to the top of the recency (in their own order) so the catalog looks
 * as it did; from then on a drag moves them. Members of favorite folders,
 * and of the folders shown in them, go up with their folder. Returns the
 * history to store, or null when there is nothing to lift.
 */
export function liftFavoritesOnce(
    modules: ReadonlyArray<SortableModule>,
    folders: ReadonlyArray<SortableModuleFolder & { nodeOnlyParentFolderId?: string }>,
    history: ReadonlyArray<string> | undefined,
    fallbackOrders: Array<ReadonlyArray<string> | undefined> = [],
): string[] | null {
    const favoriteFolders = new Set(folders.filter((folder) => folder.favorite).map((folder) => folder.id))
    let grew = true
    while (grew) {
        grew = false
        for (const folder of folders) {
            if (!favoriteFolders.has(folder.id) && folder.nodeOnlyParentFolderId && favoriteFolders.has(folder.nodeOnlyParentFolderId)) {
                favoriteFolders.add(folder.id)
                grew = true
            }
        }
    }
    const lifted = modules.filter((module) => module.favorite
        || (!!module.folderId && favoriteFolders.has(module.folderId))
        || folders.some((folder) => favoriteFolders.has(folder.id) && folder.moduleIds?.includes(module.id)))
        .map((module) => module.id)
    if (lifted.length === 0) return null
    return liftModulesToNewest(history, fallbackOrders, lifted)
}

/** liftFavoritesOnce on the database, the first time either module list opens. */
export function unpinModuleFavoritesOnce(db: {
    modules: ReadonlyArray<SortableModule>
    moduleFolders?: ReadonlyArray<SortableModuleFolder & { nodeOnlyParentFolderId?: string }>
    moduleActivationHistory?: string[]
    enabledModules?: ReadonlyArray<string>
    nodeOnlyModuleFavoritesUnpinned?: boolean
}): void {
    if (db.nodeOnlyModuleFavoritesUnpinned) return
    const lifted = liftFavoritesOnce(db.modules ?? [], db.moduleFolders ?? [], db.moduleActivationHistory, [db.enabledModules])
    if (lifted) db.moduleActivationHistory = lifted
    db.nodeOnlyModuleFavoritesUnpinned = true
}

/** Store a menu/drag order in the small folder overlay, not in db.modules. */
export function recordModuleFolderOrder<T extends SortableModuleFolder>(folders: ReadonlyArray<T>): T[] {
    return folders.map((folder, sortOrder) => ({ ...folder, sortOrder }))
}

/** A new activation supersedes manual order for that folder only. */
export function recordModuleFolderActivation<T extends SortableModuleFolder>(
    folders: ReadonlyArray<T>,
    modules: ReadonlyArray<SortableModule>,
    moduleId: string,
    options: ModuleSortOptions = {},
): T[] {
    const module = modules.find((item) => item.id === moduleId)
    const folderId = module?.folderId
        || folders.find((folder) => folder.moduleIds?.includes(moduleId))?.id
    if (!folderId || !folders.some((folder) => folder.id === folderId)) return [...folders]
    const ordered = sortModuleFoldersByActivation(folders, modules, options)
    const from = ordered.findIndex((folder) => folder.id === folderId)
    const [folder] = ordered.splice(from, 1)
    ordered.unshift(folder)
    return recordModuleFolderOrder(ordered)
}
