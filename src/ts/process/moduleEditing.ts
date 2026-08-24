/**
 * Resolve a detached module draft back to its current array slot.
 *
 * Object identity wins so malformed duplicate ids remain independently
 * editable. If another writer replaced the array objects, a stable id is safe
 * only when it identifies exactly one current module.
 */
export function resolveModuleEditTargetIndex<T extends { id?: unknown }>(
    modules: ReadonlyArray<T>,
    moduleId: string,
    originalModule: T | null | undefined,
): number {
    if(originalModule){
        const referenceIndex = modules.indexOf(originalModule)
        if(referenceIndex !== -1) return referenceIndex
    }

    let matchIndex = -1
    for(let index = 0; index < modules.length; index++){
        if(modules[index]?.id !== moduleId) continue
        if(matchIndex !== -1) return -1
        matchIndex = index
    }
    return matchIndex
}
