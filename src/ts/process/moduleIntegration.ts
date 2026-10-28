// The prompt preset's "module integration" field, shown again (the user's
// request, 2026-10-28). A preset lists module namespaces (or ids) in
// `moduleIntergration`; choosing the preset turns those modules on
// (database.svelte.ts getEnabledModuleDefinitions matches id or namespace).
// PocketRisu dropped the field from the settings screen on 2026-06-02, so a
// link a preset brought in could be neither seen nor removed.

export interface IntegrationModule {
    id: string
    name: string
    namespace?: string
}

export interface IntegrationLink {
    value: string
    /** Every installed module the value turns on (one namespace may name several). */
    modules: { id: string, name: string }[]
}

export interface IntegrationCandidate {
    namespace: string
    names: string[]
}

/** The names in the field, trimmed, without blanks or repeats. */
export function integrationNames(value: string | undefined): string[] {
    return [...new Set((value ?? '').split(',').map((name) => name.trim()).filter(Boolean))]
}

/** What each name in the field turns on, matched as the module loader does. */
export function resolveIntegration(value: string | undefined, modules: readonly (IntegrationModule | null | undefined)[]): IntegrationLink[] {
    return integrationNames(value).map((name) => ({
        value: name,
        modules: modules
            .filter((module): module is IntegrationModule => !!module && (module.id === name || (!!module.namespace && module.namespace === name)))
            .map((module) => ({ id: module.id, name: module.name })),
    }))
}

export function addIntegration(value: string | undefined, name: string): string {
    const names = integrationNames(value)
    const added = name.trim()
    if (added && !names.includes(added)) names.push(added)
    return names.join(', ')
}

export function removeIntegration(value: string | undefined, name: string): string {
    return integrationNames(value).filter((item) => item !== name).join(', ')
}

/** Namespaces of installed modules not in the field yet, by first module name. */
export function integrationCandidates(value: string | undefined, modules: readonly (IntegrationModule | null | undefined)[]): IntegrationCandidate[] {
    const linked = new Set(integrationNames(value))
    const byNamespace = new Map<string, string[]>()
    for (const module of modules) {
        const namespace = module?.namespace?.trim()
        if (!namespace || linked.has(namespace)) continue
        const names = byNamespace.get(namespace) ?? []
        names.push(module.name)
        byNamespace.set(namespace, names)
    }
    return [...byNamespace].map(([namespace, names]) => ({ namespace, names }))
        .sort((a, b) => a.names[0].localeCompare(b.names[0]))
}
