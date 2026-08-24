export type ModuleRuntimeSource = {
    id?: string
    hideIcon?: boolean
    backgroundEmbedding?: string
} | null | undefined

export function collectModuleRuntimeUi(modules: ModuleRuntimeSource[]) {
    let hideIcon = false
    let backgroundEmbedding = ''
    const ids: string[] = []
    for (const module of modules) {
        if (!module) continue
        if (module.id) ids.push(module.id)
        if (module.hideIcon) hideIcon = true
        if (module.backgroundEmbedding) {
            backgroundEmbedding += `\n${module.backgroundEmbedding}\n`
        }
    }
    return {
        // Module ids are importable strings and may contain '-'. JSON keeps
        // ['a-b', 'c'] distinct from ['a', 'b-c'] for reload detection.
        ids: JSON.stringify(ids),
        hideIcon,
        backgroundEmbedding,
    }
}
