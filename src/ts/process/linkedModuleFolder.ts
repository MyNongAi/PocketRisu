import {
    dissolveShrunkenModuleFolders,
    normalizeModuleFolders,
    synchronizeModuleFolderMembership,
    type FolderableModule,
    type ModuleFolder,
} from './moduleFolders'

// Modules a bot carries as its own (character.modules: the chat module menu's
// "이 캐릭터에서 사용", the module ⋮ menu's link, a Realm companion module)
// gather in one [링크] folder of the module catalog (the user's request,
// 2026-10-07). A folder the user made keeps its modules; only loose modules
// and the generated folders ([유사 후보], source folders) give theirs up. A
// module no bot links any more leaves [링크] for the top level.

export const LINK_FOLDER_NAME = '[링크]'

/** Module ids that a bot outside the trash lists as its own. */
export function linkedModuleIds(characters: readonly ({ modules?: string[], trashTime?: number } | null | undefined)[] | undefined): Set<string> {
    const ids = new Set<string>()
    for (const character of characters ?? []) {
        if (!character || character.trashTime) continue
        for (const id of character.modules ?? []) ids.add(id)
    }
    return ids
}

function isGeneratedFolder(folder: ModuleFolder): boolean {
    return folder.duplicateCandidate?.kind === 'module'
        || folder.name.trimStart().startsWith('[유사 후보]')
        || !!folder.sourceInfo
}

/**
 * The catalog after gathering: linked modules that are loose or in a
 * generated folder move into the [링크] folder (made at the top when first
 * needed, removed when it empties), unlinked ones leave it. Null when
 * nothing changes. A moved module is a new object, so the save tracker sees
 * only those.
 */
export function gatherLinkedModules<T extends FolderableModule>(
    modules: readonly T[],
    folders: unknown,
    linked: ReadonlySet<string>,
    createId: () => string,
): { modules: T[], folders: ModuleFolder[] } | null {
    const current = normalizeModuleFolders(folders)
    const byId = new Map(current.map((folder) => [folder.id, folder]))
    let link = current.find((folder) => folder.nodeOnlyLinkFolder)
    const linkId = link?.id ?? createId()
    let changed = false
    const nextModules = modules.map((module) => {
        const folder = module.folderId ? byId.get(module.folderId) : undefined
        if (linked.has(module.id)) {
            if (folder?.id === linkId) return module
            if (folder && !isGeneratedFolder(folder)) return module
            changed = true
            return { ...module, folderId: linkId }
        }
        if (folder && folder.id === linkId) {
            changed = true
            return { ...module, folderId: undefined }
        }
        return module
    })
    if (!changed) return null

    const stillUsed = nextModules.some((module) => module.folderId === linkId)
    let nextFolders = current
    if (!link && stillUsed) {
        link = { id: linkId, name: LINK_FOLDER_NAME, moduleIds: [], nodeOnlyLinkFolder: true }
        nextFolders = [link, ...current]
    } else if (link && !stillUsed) {
        nextFolders = current.filter((folder) => folder.id !== linkId)
    }
    const synchronized = synchronizeModuleFolderMembership(nextModules, nextFolders, { importLegacyWhenFolderIdsEmpty: false })
    // A generated folder that lost its members to [링크] goes, as after a drag.
    return dissolveShrunkenModuleFolders(nextModules, synchronized, current)
}
