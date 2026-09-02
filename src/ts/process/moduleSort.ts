export interface SortableModule {
    id: string
    name: string
    folderId?: string
}

export interface SortableModuleFolder {
    id: string
    moduleIds?: ReadonlyArray<string>
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
        .sort((a, b) => b.rank - a.rank || a.index - b.index)
        .map(({ folder }) => folder)
}
