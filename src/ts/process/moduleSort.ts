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
        const favoriteOrder = Number(!!b.favorite) - Number(!!a.favorite)
        if (favoriteOrder) return favoriteOrder
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
            const favoriteOrder = Number(!!b.folder.favorite) - Number(!!a.folder.favorite)
            if (favoriteOrder) return favoriteOrder
            const aOrder = Number.isFinite(a.folder.sortOrder) ? a.folder.sortOrder! : undefined
            const bOrder = Number.isFinite(b.folder.sortOrder) ? b.folder.sortOrder! : undefined
            if (hasExplicitOrder) return (aOrder ?? Infinity) - (bOrder ?? Infinity) || a.index - b.index
            return b.rank - a.rank || a.index - b.index
        })
        .map(({ folder }) => folder)
}

/** Store a menu/drag order in the small folder overlay, not in db.modules. */
export function recordModuleFolderOrder<T extends SortableModuleFolder>(folders: ReadonlyArray<T>): T[] {
    return folders.map((folder, sortOrder) => ({ ...folder, sortOrder }))
}

/** A new activation supersedes manual order for that folder only. Pinned folders stay first. */
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
