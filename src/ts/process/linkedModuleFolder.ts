import {
    dissolveShrunkenModuleFolders,
    normalizeModuleFolders,
    synchronizeModuleFolderMembership,
    type FolderableModule,
    type ModuleFolder,
} from './moduleFolders'
import { similarNameGroups, similarityFolderName } from './similarityFolders'
import { normalizeDuplicateName } from '../sourceCollectionDuplicates'

// Modules a bot carries as its own (character.modules: the chat module menu's
// "이 캐릭터에서 사용", the module ⋮ menu's link, a Realm companion module)
// gather in one [링크] folder of the module catalog (the user's request,
// 2026-10-07; the bot list has the same, linkedBotFolder.ts). Only loose
// modules move into it. A folder that holds a linked module is shown inside
// [링크] as it is, folder in folder like the bot list (display-only:
// nodeOnlyParentFolderId), so a catalog without folders in folders still has
// every folder with its own modules (2026-10-08: no module leaves its folder).
// Linked modules with near-duplicate names that sit loose in [링크] get their
// own [유사 후보] folder inside it. A module no bot links any more leaves
// [링크] for the top level, and a folder with none comes back out.

export const LINK_FOLDER_NAME = '[링크]'
/** The name it carried on 2026-10-07/08; the UI now draws the green chain itself. */
const LEGACY_LINK_FOLDER_NAME = '🔗 [링크]'

/** Module ids that a bot outside the trash lists as its own. */
export function linkedModuleIds(characters: readonly ({ modules?: string[], trashTime?: number } | null | undefined)[] | undefined): Set<string> {
    const ids = new Set<string>()
    for (const character of characters ?? []) {
        if (!character || character.trashTime) continue
        for (const id of character.modules ?? []) ids.add(id)
    }
    return ids
}

type GatherModule = FolderableModule & { sourceInfo?: { label?: string } }

/**
 * The catalog after gathering, or null when nothing changes. The [링크]
 * folder is made at the top when first needed and removed when nothing is
 * in or under it. A moved module is a new object, so the save tracker sees
 * only those.
 */
export function gatherLinkedModules<T extends GatherModule>(
    modules: readonly T[],
    folders: unknown,
    linked: ReadonlySet<string>,
    createId: () => string,
): { modules: T[], folders: ModuleFolder[] } | null {
    const current = normalizeModuleFolders(folders)
    const byId = new Map(current.map((folder) => [folder.id, folder]))
    const link = current.find((folder) => folder.nodeOnlyLinkFolder)
    const linkId = link?.id ?? createId()
    let changed = false

    // Folders that hold a linked module are shown inside [링크].
    const nested = new Set<string>()
    for (const module of modules) {
        if (linked.has(module.id) && module.folderId && module.folderId !== linkId && byId.has(module.folderId)) nested.add(module.folderId)
    }

    let nextModules = modules.map((module) => {
        const folder = module.folderId ? byId.get(module.folderId) : undefined
        if (linked.has(module.id)) {
            if (folder) return module
            changed = true
            return { ...module, folderId: linkId }
        }
        if (folder && folder.id === linkId) {
            changed = true
            return { ...module, folderId: undefined }
        }
        return module
    })

    // Near-duplicates loose in [링크] get a [유사 후보] folder inside it.
    const created: ModuleFolder[] = []
    for (const group of similarNameGroups(nextModules.filter((module) => module.folderId === linkId))) {
        const folder: ModuleFolder = {
            id: createId(),
            name: similarityFolderName(group),
            moduleIds: [],
            duplicateCandidate: { kind: 'module', key: normalizeDuplicateName(group[0].name) },
            nodeOnlyParentFolderId: linkId,
        }
        created.push(folder)
        const ids = new Set(group.map((module) => module.id))
        nextModules = nextModules.map((module) => (ids.has(module.id) ? { ...module, folderId: folder.id } : module))
        changed = true
    }

    let nextFolders: ModuleFolder[] = current.map((folder) => {
        if (folder.id === linkId) {
            if (folder.name !== LEGACY_LINK_FOLDER_NAME) return folder
            changed = true
            return { ...folder, name: LINK_FOLDER_NAME }
        }
        const under = folder.nodeOnlyParentFolderId === linkId
        if (nested.has(folder.id) && !under) {
            changed = true
            return { ...folder, nodeOnlyParentFolderId: linkId }
        }
        if (!nested.has(folder.id) && under) {
            changed = true
            const { nodeOnlyParentFolderId: _dropped, ...rest } = folder
            return rest
        }
        return folder
    })
    nextFolders = [...created, ...nextFolders]

    const used = nextModules.some((module) => module.folderId === linkId)
        || nextFolders.some((folder) => folder.nodeOnlyParentFolderId === linkId)
    if (!link && used) {
        nextFolders = [{ id: linkId, name: LINK_FOLDER_NAME, moduleIds: [], nodeOnlyLinkFolder: true }, ...nextFolders]
        changed = true
    } else if (link && !used) {
        nextFolders = nextFolders.filter((folder) => folder.id !== linkId)
        changed = true
    }
    if (!changed) return null

    const synchronized = synchronizeModuleFolderMembership(nextModules, nextFolders, { importLegacyWhenFolderIdsEmpty: false })
    // A generated folder that lost its members to [링크] goes, as after a
    // drag; [링크] itself stays while anything is in or under it.
    return dissolveShrunkenModuleFolders(nextModules, synchronized, current.filter((folder) => folder.id !== linkId))
}
