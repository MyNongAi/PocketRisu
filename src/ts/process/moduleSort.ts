export interface SortableModule {
    id: string
    name: string
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
    ...activationOrders: Array<ReadonlyArray<string> | undefined>
): T[] {
    const normalizedSearch = search.trim().toLocaleLowerCase()
    const activationOrder = mergeActivationOrders(activationOrders)
    const activationRank = new Map(activationOrder.map((id, index) => [id, index]))

    return modules.filter((module) => {
        if(normalizedSearch === '') return true
        return module.name.toLocaleLowerCase().includes(normalizedSearch)
    }).sort((a, b) => {
        const aRank = activationRank.get(a.id)
        const bRank = activationRank.get(b.id)
        const aActive = aRank !== undefined
        const bActive = bRank !== undefined

        if(aActive !== bActive){
            return aActive ? -1 : 1
        }
        if(aActive && bActive && aRank !== bRank){
            return bRank - aRank
        }
        return a.name.localeCompare(b.name)
    })
}
