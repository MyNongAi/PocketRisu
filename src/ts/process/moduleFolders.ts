export interface ModuleFolder {
    id: string
    name: string
    moduleIds: string[]
    collapsed?: boolean
    /** PocketRisu collection provenance for a generated source folder. */
    sourceInfo?: import('../sourceCollection').SourceImportInfo
}

export interface FolderableModule {
    id: string
    name: string
}

export type ModuleCatalogEntry<T extends FolderableModule> =
    | { kind: 'module'; module: T }
    | { kind: 'folder'; folder: ModuleFolder; modules: T[] }

function normalizeSearch(search: string) {
    return search.trim().toLocaleLowerCase()
}

/**
 * Sanitize folder metadata loaded from backups/plugins without changing any
 * module ids. The first valid folder id and first membership win, matching the
 * catalog's historical malformed-data behavior.
 *
 * Unknown folder fields are preserved for forward compatibility, while every
 * field consumed by the current UI is normalized to a safe runtime shape.
 */
export function normalizeModuleFolders(value: unknown): ModuleFolder[] {
    if(!Array.isArray(value)) return []

    const folders: ModuleFolder[] = []
    const seenFolderIds = new Set<string>()
    const claimedModuleIds = new Set<string>()

    for(const candidate of value){
        if(!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
        const raw = candidate as Record<string, unknown>
        if(typeof raw.id !== 'string' || raw.id.trim() === '' || seenFolderIds.has(raw.id)) continue

        const moduleIds: string[] = []
        if(Array.isArray(raw.moduleIds)){
            for(const moduleId of raw.moduleIds){
                if(typeof moduleId !== 'string' || moduleId === '' || claimedModuleIds.has(moduleId)) continue
                claimedModuleIds.add(moduleId)
                moduleIds.push(moduleId)
            }
        }

        const folder = {
            ...raw,
            id: raw.id,
            name: typeof raw.name === 'string' ? raw.name : '',
            moduleIds,
        } as unknown as ModuleFolder
        if(typeof raw.collapsed === 'boolean') folder.collapsed = raw.collapsed
        else delete folder.collapsed

        seenFolderIds.add(folder.id)
        folders.push(folder)
    }

    return folders
}

/**
 * Add folder sections on top of an already-sorted module list.
 *
 * Important ordering contract:
 * - With no folders, the incoming visible order is returned unchanged.
 * - A folder is anchored where its first member appeared in that order.
 * - Members keep their relative incoming order inside the folder.
 * - Empty folders appear after the module list in folder metadata order.
 *
 * Folder metadata therefore never rewrites the underlying `db.modules` array,
 * and activation-recency sorting can continue to run before this function.
 */
export function buildModuleFolderCatalog<T extends FolderableModule>(
    sortedModules: ReadonlyArray<T>,
    folders: unknown,
    search = '',
): ModuleCatalogEntry<T>[] {
    const normalizedSearch = normalizeSearch(search)
    const validFolders = normalizeModuleFolders(folders)
    const folderById = new Map(validFolders.map((folder) => [folder.id, folder]))

    if(validFolders.length === 0){
        return sortedModules
            .filter((module) => normalizedSearch === '' || module.name.toLocaleLowerCase().includes(normalizedSearch))
            .map((module) => ({ kind: 'module' as const, module }))
    }

    // The first folder wins if malformed/legacy metadata contains duplicates.
    const moduleFolderId = new Map<string, string>()
    for(const folder of validFolders){
        for(const moduleId of folder.moduleIds){
            if(!moduleFolderId.has(moduleId)) moduleFolderId.set(moduleId, folder.id)
        }
    }

    const folderMembers = new Map<string, T[]>()
    const folderAnchor = new Map<string, number>()
    for(const folder of validFolders) folderMembers.set(folder.id, [])

    for(let index = 0; index < sortedModules.length; index++){
        const module = sortedModules[index]
        const folderId = moduleFolderId.get(module.id)
        if(!folderId || !folderById.has(folderId)) continue
        folderMembers.get(folderId)?.push(module)
        if(!folderAnchor.has(folderId)) folderAnchor.set(folderId, index)
    }

    const visibleFolderMembers = new Map<string, T[]>()
    for(const folder of validFolders){
        const members = folderMembers.get(folder.id) ?? []
        const folderMatches = normalizedSearch !== '' && folder.name.toLocaleLowerCase().includes(normalizedSearch)
        visibleFolderMembers.set(
            folder.id,
            normalizedSearch === '' || folderMatches
                ? members
                : members.filter((module) => module.name.toLocaleLowerCase().includes(normalizedSearch)),
        )
    }

    const result: ModuleCatalogEntry<T>[] = []
    const emittedFolders = new Set<string>()

    for(let index = 0; index < sortedModules.length; index++){
        const module = sortedModules[index]
        const folderId = moduleFolderId.get(module.id)

        if(folderId && folderById.has(folderId)){
            if(folderAnchor.get(folderId) === index && !emittedFolders.has(folderId)){
                emittedFolders.add(folderId)
                const visibleMembers = visibleFolderMembers.get(folderId) ?? []
                const folder = folderById.get(folderId)!
                const folderMatches = normalizedSearch !== '' && folder.name.toLocaleLowerCase().includes(normalizedSearch)
                if(visibleMembers.length > 0 || folderMatches){
                    result.push({ kind: 'folder', folder, modules: visibleMembers })
                }
            }
            continue
        }

        if(normalizedSearch === '' || module.name.toLocaleLowerCase().includes(normalizedSearch)){
            result.push({ kind: 'module', module })
        }
    }

    // A folder with no existing members has no natural anchor, so keep it at
    // the end without disturbing the visible order of existing modules.
    for(const folder of validFolders){
        if(emittedFolders.has(folder.id)) continue
        const folderMatches = normalizedSearch !== '' && folder.name.toLocaleLowerCase().includes(normalizedSearch)
        if(normalizedSearch === '' || folderMatches){
            result.push({ kind: 'folder', folder, modules: [] })
        }
    }

    return result
}

export function findModuleFolderId(
    folders: unknown,
    moduleId: string,
): string {
    for(const folder of normalizeModuleFolders(folders)){
        if(folder.moduleIds.includes(moduleId)) return folder.id
    }
    return ''
}

/** Move a module between folders without changing the module array itself. */
export function assignModuleToFolder(
    folders: unknown,
    moduleId: string,
    targetFolderId: string,
): ModuleFolder[] {
    const normalizedFolders = normalizeModuleFolders(folders)
    const targetExists = !!targetFolderId && normalizedFolders.some((folder) => folder.id === targetFolderId)

    return normalizedFolders.map((folder) => {
        const moduleIds = folder.moduleIds.filter((id) => id !== moduleId)
        if(targetExists && folder.id === targetFolderId) moduleIds.push(moduleId)
        return { ...folder, moduleIds }
    })
}
