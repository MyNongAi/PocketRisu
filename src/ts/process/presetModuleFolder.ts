import {
    normalizeModuleFolders,
    synchronizeModuleFolderMembership,
    type FolderableModule,
    type ModuleFolder,
} from './moduleFolders'

// Modules a prompt preset turns on with it (botPreset.moduleIntergration names
// their namespaces; the catalog draws them orange while that preset is in use)
// gather in a [프롬] folder of the module catalog, one folder per preset inside
// it (the user's request, 2026-10-21; a bot's own modules have [링크],
// linkedModuleFolder.ts). Each module remembers the presets it went with
// (nodeOnlyPresetLinks), so one whose presets are all gone shows in
// [프롬] › 프롬 없음 instead of sitting in the catalog unexplained. As with
// [링크], only loose modules move: one the user put in a folder stays there,
// and a module a bot carries as its own goes to [링크] instead.

export const PRESET_FOLDER_NAME = '[프롬]'
export const PRESET_ORPHAN_FOLDER_NAME = '프롬 없음'

export type PresetFolderKind = 'root' | 'preset' | 'orphans'

type PresetLike = { name?: string, moduleIntergration?: string } | null | undefined
type PresetModule = FolderableModule & { namespace?: string, nodeOnlyPresetLinks?: string[] }
type PresetFolder = ModuleFolder & { nodeOnlyPresetFolder?: PresetFolderKind, nodeOnlyPresetName?: string }

const ORPHAN = Symbol('orphan')

/** Preset names by the module namespace they turn on, in preset order. */
export function presetsByNamespace(presets: readonly PresetLike[] | undefined): Map<string, string[]> {
    const map = new Map<string, string[]>()
    for (const preset of presets ?? []) {
        const name = preset?.name?.trim()
        if (!name) continue
        for (const namespace of (preset?.moduleIntergration ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
            const names = map.get(namespace) ?? []
            if (!names.includes(name)) names.push(name)
            map.set(namespace, names)
        }
    }
    return map
}

/** Remember on each module the presets that turn it on now (never forgets one). True when a record changed. */
export function recordPresetLinks(modules: PresetModule[] | undefined, presets: readonly PresetLike[] | undefined): boolean {
    const byNamespace = presetsByNamespace(presets)
    let changed = false
    for (const module of modules ?? []) {
        const names = module?.namespace ? byNamespace.get(module.namespace) : undefined
        if (!names) continue
        const known = module.nodeOnlyPresetLinks ?? []
        const added = names.filter((name) => !known.includes(name))
        if (added.length === 0) continue
        module.nodeOnlyPresetLinks = [...known, ...added]
        changed = true
    }
    return changed
}

/** The preset a module goes under, ORPHAN when every preset it went with is gone, or null. */
function presetHome(module: PresetModule, byNamespace: ReadonlyMap<string, string[]>, presetNames: ReadonlySet<string>): string | typeof ORPHAN | null {
    const current = module.namespace ? byNamespace.get(module.namespace) : undefined
    if (current?.length) return current[0]
    const recorded = module.nodeOnlyPresetLinks ?? []
    if (recorded.length > 0 && !recorded.some((name) => presetNames.has(name))) return ORPHAN
    return null
}

/**
 * The catalog with its [프롬] folder brought up to date, or null when nothing
 * changes. `botLinked`: modules a bot carries, left to [링크].
 */
export function gatherPresetModules<T extends PresetModule>(
    modules: readonly T[],
    folders: unknown,
    presets: readonly PresetLike[] | undefined,
    botLinked: ReadonlySet<string>,
    createId: () => string,
): { modules: T[], folders: ModuleFolder[] } | null {
    const current = normalizeModuleFolders(folders) as PresetFolder[]
    const byId = new Map(current.map((folder) => [folder.id, folder]))
    const ours = new Set(current.filter((folder) => folder.nodeOnlyPresetFolder).map((folder) => folder.id))
    const byNamespace = presetsByNamespace(presets)
    const presetNames = new Set((presets ?? []).map((preset) => preset?.name?.trim()).filter((name): name is string => !!name))

    let root = current.find((folder) => folder.nodeOnlyPresetFolder === 'root')
    const created: PresetFolder[] = []
    let changed = false
    const rootId = () => {
        if (!root) {
            root = { id: createId(), name: PRESET_FOLDER_NAME, moduleIds: [], nodeOnlyPresetFolder: 'root' }
            created.push(root)
        }
        return root.id
    }
    const folderFor = (home: string | typeof ORPHAN): string => {
        const kind: PresetFolderKind = home === ORPHAN ? 'orphans' : 'preset'
        const found = [...current, ...created].find((folder) => folder.nodeOnlyPresetFolder === kind && (home === ORPHAN || folder.nodeOnlyPresetName === home))
        if (found) return found.id
        const folder: PresetFolder = {
            id: createId(),
            name: home === ORPHAN ? PRESET_ORPHAN_FOLDER_NAME : home,
            moduleIds: [],
            nodeOnlyPresetFolder: kind,
            nodeOnlyParentFolderId: rootId(),
            ...(home === ORPHAN ? {} : { nodeOnlyPresetName: home }),
        }
        created.push(folder)
        return folder.id
    }

    const nextModules = modules.map((module) => {
        const inOurs = !!module.folderId && ours.has(module.folderId)
        const loose = !module.folderId || !byId.has(module.folderId) || inOurs
        if (!loose) return module
        const home = botLinked.has(module.id) ? null : presetHome(module, byNamespace, presetNames)
        const target = home === null ? undefined : folderFor(home)
        if ((module.folderId ?? undefined) === target || (!inOurs && target === undefined)) return module
        changed = true
        return { ...module, folderId: target }
    })

    // Folders of ours that hold nothing go; the root goes once it holds none.
    const all = [...created, ...current]
    const used = new Set(nextModules.map((module) => module.folderId).filter(Boolean))
    let nextFolders = all.filter((folder) => {
        if (folder.nodeOnlyPresetFolder === 'preset' || folder.nodeOnlyPresetFolder === 'orphans') return used.has(folder.id)
        return true
    })
    const rootUsed = root && nextFolders.some((folder) => folder.nodeOnlyParentFolderId === root!.id && folder.nodeOnlyPresetFolder)
    if (root && !rootUsed) nextFolders = nextFolders.filter((folder) => folder.id !== root!.id)
    if (nextFolders.length !== current.length || created.some((folder) => nextFolders.includes(folder))) changed = true
    if (!changed) return null
    return { modules: nextModules, folders: synchronizeModuleFolderMembership(nextModules, nextFolders, { importLegacyWhenFolderIdsEmpty: false }) }
}
