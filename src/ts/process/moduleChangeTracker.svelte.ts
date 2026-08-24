import { deepTouch } from '../gui/deepTouch.svelte'

export type ModuleTreeChange =
    | { kind: 'structure' }
    | {
        kind: 'content'
        moduleId: string | null
        replaced?: boolean
        routingChanged?: boolean
    }

/**
 * Rebase content-only local module edits on a newer server array. Unrelated
 * server modules stay intact. Structural/legacy changes (null/undefined hint)
 * intentionally keep the historical whole-array local-wins behavior.
 */
export function mergeTrackedModuleChanges<T extends { id?: unknown }>(
    latestModules: T[] | null | undefined,
    localModules: T[] | null | undefined,
    dirtyModuleIds: string[] | null | undefined,
): T[] {
    const latest = Array.isArray(latestModules) ? latestModules : []
    const local = Array.isArray(localModules) ? localModules : []
    if (!Array.isArray(dirtyModuleIds)) return local

    const latestIds = latest.map(module => module?.id)
    const localIds = local.map(module => module?.id)
    const idsAreUnsafe = latestIds.some(id => typeof id !== 'string' || !id)
        || localIds.some(id => typeof id !== 'string' || !id)
        || new Set(latestIds).size !== latestIds.length
        || new Set(localIds).size !== localIds.length
    if (idsAreUnsafe) return local

    const dirtyIds = new Set(dirtyModuleIds)
    const localById = new Map(local.map(module => [module.id as string, module] as const))
    const merged = latest
        .filter(module => !dirtyIds.has(module.id as string) || localById.has(module.id as string))
        .map(module => dirtyIds.has(module.id as string)
            ? localById.get(module.id as string)!
            : module)
    const mergedIds = new Set(merged.map(module => module.id as string))
    for (const moduleId of dirtyIds) {
        const localModule = localById.get(moduleId)
        if (localModule && !mergedIds.has(moduleId)) {
            merged.push(localModule)
        }
    }
    return merged
}

/**
 * Track a reactive modules array without making every edit depend on every
 * module in the database.
 *
 * The outer effect subscribes only to the array reference, length and slots.
 * Each module gets its own child effect that deep-subscribes to that one item.
 * Svelte tears the children down and recreates them when the array structure
 * changes. A nested edit therefore walks only the edited module, while
 * Add/remove/reorder/id changes are structural. Replacing an item with a draft
 * that has the same stable id is reported as precise content replacement.
 *
 * This must be called from an active effect root (saveDb already owns one).
 */
export function trackModuleTreeChanges(
    readModules: () => any[] | null | undefined,
    onChange: (change: ModuleTreeChange) => void,
): void {
    let didInitStructure = false
    let previousModules: any[] = []
    let previousIds: Array<string | null> = []

    $effect(() => {
        const source = readModules() ?? []
        const length = source.length
        const modules = new Array<any>(length)
        for (let i = 0; i < length; i++) {
            // Reading the slot tracks replacement/reorder, not fields inside it.
            modules[i] = source[i]
        }
        const ids = modules.map(module => typeof module?.id === 'string' && module.id
            ? module.id
            : null)

        if (didInitStructure) {
            const idsAreSafe = ids.every(Boolean) && new Set(ids).size === ids.length
            const sameIdOrder = idsAreSafe
                && ids.length === previousIds.length
                && ids.every((id, index) => id === previousIds[index])
            if (!sameIdOrder) {
                onChange({ kind: 'structure' })
            } else {
                // Replacing one slot with an edited draft is content-only when
                // its stable id stays at the same index. Preserve that precise
                // dirty id so save patching does not fall back to all modules.
                for (let i = 0; i < modules.length; i++) {
                    if (modules[i] !== previousModules[i]) {
                        onChange({ kind: 'content', moduleId: ids[i], replaced: true })
                    }
                }
            }
        } else {
            didInitStructure = true
        }
        previousModules = modules
        previousIds = ids

        for (const module of modules) {
            let didInitItem = false
            let previousNamespace: unknown
            $effect(() => {
                deepTouch(module)
                const namespace = module?.namespace
                if (!didInitItem) {
                    didInitItem = true
                    previousNamespace = namespace
                    return
                }
                const moduleId = typeof module?.id === 'string' && module.id
                    ? module.id
                    : null
                const routingChanged = namespace !== previousNamespace
                previousNamespace = namespace
                onChange({
                    kind: 'content',
                    moduleId,
                    ...(routingChanged ? { routingChanged: true } : {}),
                })
            })
        }
    })
}
