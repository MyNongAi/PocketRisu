export interface SortableModule {
    id: string
    name: string
}

export interface ModuleSortOptions {
    activeOrders?: Array<ReadonlyArray<string> | undefined>
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
    const activeOrder = mergeActivationOrders(options.activeOrders ?? [])
    const activeIds = new Set(activeOrder)
    const recencyOrder = mergeActivationOrders([
        activeOrder,
        options.activationHistory,
    ])
    const recencyRank = new Map(recencyOrder.map((id, index) => [id, index]))

    return modules.filter((module) => {
        if(normalizedSearch === '') return true
        return module.name.toLocaleLowerCase().includes(normalizedSearch)
    }).sort((a, b) => {
        const aRank = recencyRank.get(a.id)
        const bRank = recencyRank.get(b.id)
        const aActive = activeIds.has(a.id)
        const bActive = activeIds.has(b.id)

        if(aActive !== bActive){
            return aActive ? -1 : 1
        }
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

export function recordModuleActivation(
    history: ReadonlyArray<string> | undefined,
    moduleId: string,
): string[] {
    return [
        ...(history ?? []).filter((id) => id !== moduleId),
        moduleId,
    ]
}
