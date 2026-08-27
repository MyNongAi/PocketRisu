export interface ModuleFolder {
    id: string
    name: string
    moduleIds: string[]
    collapsed?: boolean
    /** PocketRisu collection provenance for a generated source folder. */
    sourceInfo?: import('../sourceCollection').SourceImportInfo
    /** Automatically generated review folder for highly similar names. */
    duplicateCandidate?: {
        kind: 'module'
        key: string
    }
}

export interface FolderableModule {
    id: string
    name: string
}

export type ModuleCatalogEntry<T extends FolderableModule> =
    | { kind: 'module'; module: T }
    | { kind: 'folder'; folder: ModuleFolder; modules: T[] }

export type ModuleDropTarget =
    | { kind: 'module'; moduleId: string; position: 'before' | 'after' }
    | { kind: 'folder'; folderId: string }
    | { kind: 'root' }

export type ModuleFolderDropTarget =
    | { kind: 'module'; moduleId: string; position: 'before' | 'after' }
    | { kind: 'folder'; folderId: string; position: 'before' | 'after' }
    | { kind: 'root' }

export interface ModuleDropResult {
    folders: ModuleFolder[]
    /** Top-to-bottom visual module order after the drop. */
    orderedModuleIds: string[]
}

function normalizeSearch(search: string) {
    return search.trim().toLocaleLowerCase()
}

function isSimilarityReviewFolder(folder: ModuleFolder): boolean {
    // Older database serializers can preserve the generated display name while
    // dropping newer optional metadata. The prefix keeps those folders pinned
    // after a save/reload without changing ordinary user folders.
    return folder.duplicateCandidate?.kind === 'module'
        || folder.name.trimStart().startsWith('[유사 후보]')
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
 * - Automatically generated similarity-review folders stay at the top in
 *   folder metadata order.
 * - Empty manual folders follow them in folder metadata order.
 * - A folder is anchored where its first member appeared in that order.
 * - Members keep their relative incoming order inside the folder.
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

    // Similarity folders are explicitly review queues, so keep them above all
    // ordinary folders and root modules regardless of activation recency.
    for(const folder of validFolders){
        if(!isSimilarityReviewFolder(folder)) continue
        const visibleMembers = visibleFolderMembers.get(folder.id) ?? []
        const folderMatches = normalizedSearch !== '' && folder.name.toLocaleLowerCase().includes(normalizedSearch)
        if(visibleMembers.length > 0 || folderMatches){
            emittedFolders.add(folder.id)
            result.push({ kind: 'folder', folder, modules: visibleMembers })
        }
    }

    // A newly created folder has no member from which to derive an anchor.
    // Render those folders first in metadata order so the create action has an
    // immediate, predictable result at the top of the catalog.
    for(const folder of validFolders){
        if(emittedFolders.has(folder.id)) continue
        if((folderMembers.get(folder.id)?.length ?? 0) !== 0) continue
        const folderMatches = normalizedSearch !== '' && folder.name.toLocaleLowerCase().includes(normalizedSearch)
        if(normalizedSearch === '' || folderMatches){
            emittedFolders.add(folder.id)
            result.push({ kind: 'folder', folder, modules: [] })
        }
    }

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

    // A malformed folder can lose its anchor after filtering. Preserve it
    // instead of silently dropping its metadata.
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

function uniqueModuleIds(moduleIds: ReadonlyArray<string>) {
    const seen = new Set<string>()
    return moduleIds.filter((id) => {
        if(typeof id !== 'string' || id === '' || seen.has(id)) return false
        seen.add(id)
        return true
    })
}

/**
 * Apply a module drag/drop to the small ordering and folder overlays only.
 *
 * `orderedModuleIds` is the current top-to-bottom visual order. The caller can
 * persist its reverse as `moduleActivationHistory`, whose newest item is stored
 * last. This keeps a manual drag immediately visible while preserving the
 * existing rule that the next activated module moves to the top.
 */
export function moveModuleByDrop(
    orderedModuleIds: ReadonlyArray<string>,
    folders: unknown,
    draggedModuleId: string,
    target: ModuleDropTarget,
): ModuleDropResult {
    const currentOrder = uniqueModuleIds(orderedModuleIds)
    const normalizedFolders = normalizeModuleFolders(folders)
    if(!currentOrder.includes(draggedModuleId)){
        return { folders: normalizedFolders, orderedModuleIds: currentOrder }
    }

    if(target.kind === 'module' && target.moduleId === draggedModuleId){
        return { folders: normalizedFolders, orderedModuleIds: currentOrder }
    }

    let targetFolderId = ''
    if(target.kind === 'folder'){
        targetFolderId = normalizedFolders.some((folder) => folder.id === target.folderId)
            ? target.folderId
            : ''
    }
    else if(target.kind === 'module'){
        targetFolderId = findModuleFolderId(normalizedFolders, target.moduleId)
    }

    let nextFolders = assignModuleToFolder(
        normalizedFolders,
        draggedModuleId,
        targetFolderId,
    )
    const nextOrder = currentOrder.filter((id) => id !== draggedModuleId)
    let insertionIndex = nextOrder.length

    if(target.kind === 'module'){
        const targetIndex = nextOrder.indexOf(target.moduleId)
        if(targetIndex === -1){
            return { folders: normalizedFolders, orderedModuleIds: currentOrder }
        }
        insertionIndex = targetIndex + (target.position === 'after' ? 1 : 0)
    }
    else if(target.kind === 'folder' && targetFolderId){
        const targetMembers = new Set(
            nextFolders.find((folder) => folder.id === targetFolderId)?.moduleIds ?? [],
        )
        const lastMemberIndex = nextOrder.reduce(
            (last, id, index) => targetMembers.has(id) ? index : last,
            -1,
        )
        insertionIndex = lastMemberIndex === -1 ? nextOrder.length : lastMemberIndex + 1
    }

    nextOrder.splice(insertionIndex, 0, draggedModuleId)

    // Keep folder metadata useful to exports and future catalog implementations:
    // known members follow the same visual order, while stale ids retain their
    // original relative order at the end.
    const orderRank = new Map(nextOrder.map((id, index) => [id, index]))
    nextFolders = nextFolders.map((folder) => ({
        ...folder,
        moduleIds: folder.moduleIds
            .map((id, index) => ({ id, index, rank: orderRank.get(id) }))
            .sort((a, b) => {
                if(a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank
                if(a.rank !== undefined) return -1
                if(b.rank !== undefined) return 1
                return a.index - b.index
            })
            .map(({ id }) => id),
    }))

    return { folders: nextFolders, orderedModuleIds: nextOrder }
}

/** Move an entire folder block without nesting folders or touching db.modules. */
export function moveModuleFolderByDrop(
    orderedModuleIds: ReadonlyArray<string>,
    folders: unknown,
    draggedFolderId: string,
    target: ModuleFolderDropTarget,
): ModuleDropResult {
    const currentOrder = uniqueModuleIds(orderedModuleIds)
    const normalizedFolders = normalizeModuleFolders(folders)
    const sourceFolder = normalizedFolders.find((folder) => folder.id === draggedFolderId)
    if(!sourceFolder) return { folders: normalizedFolders, orderedModuleIds: currentOrder }

    const targetFolderId = target.kind === 'folder'
        ? target.folderId
        : target.kind === 'module'
            ? findModuleFolderId(normalizedFolders, target.moduleId)
            : ''
    const targetPosition = target.kind === 'root' ? 'after' : target.position
    if(targetFolderId === draggedFolderId){
        return { folders: normalizedFolders, orderedModuleIds: currentOrder }
    }

    const sourceMembers = new Set(sourceFolder.moduleIds)
    const movedModuleIds = currentOrder.filter((id) => sourceMembers.has(id))
    const nextOrder = currentOrder.filter((id) => !sourceMembers.has(id))
    let insertionIndex = nextOrder.length

    if(targetFolderId){
        const targetFolder = normalizedFolders.find((folder) => folder.id === targetFolderId)
        if(!targetFolder){
            return { folders: normalizedFolders, orderedModuleIds: currentOrder }
        }
        const targetMembers = new Set(targetFolder.moduleIds)
        const memberIndexes = nextOrder
            .map((id, index) => targetMembers.has(id) ? index : -1)
            .filter((index) => index !== -1)
        if(memberIndexes.length > 0){
            insertionIndex = targetPosition === 'before'
                ? Math.min(...memberIndexes)
                : Math.max(...memberIndexes) + 1
        }
    }
    else if(target.kind === 'module'){
        const targetIndex = nextOrder.indexOf(target.moduleId)
        if(targetIndex === -1){
            return { folders: normalizedFolders, orderedModuleIds: currentOrder }
        }
        insertionIndex = targetIndex + (target.position === 'after' ? 1 : 0)
    }

    nextOrder.splice(insertionIndex, 0, ...movedModuleIds)

    // Folder metadata order is the fallback for empty folders and ties. Moving
    // beside another folder updates it too; dropping at root sends it last.
    const sourceIndex = normalizedFolders.findIndex((folder) => folder.id === draggedFolderId)
    const nextFolders = normalizedFolders.filter((folder) => folder.id !== draggedFolderId)
    let folderInsertionIndex = Math.min(sourceIndex, nextFolders.length)
    if(targetFolderId){
        const targetIndex = nextFolders.findIndex((folder) => folder.id === targetFolderId)
        if(targetIndex !== -1){
            folderInsertionIndex = targetIndex + (targetPosition === 'after' ? 1 : 0)
        }
    }
    else if(target.kind === 'root'){
        folderInsertionIndex = nextFolders.length
    }
    nextFolders.splice(folderInsertionIndex, 0, sourceFolder)

    const orderRank = new Map(nextOrder.map((id, index) => [id, index]))
    return {
        orderedModuleIds: nextOrder,
        folders: nextFolders.map((folder) => ({
            ...folder,
            moduleIds: folder.moduleIds
                .map((id, index) => ({ id, index, rank: orderRank.get(id) }))
                .sort((a, b) => {
                    if(a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank
                    if(a.rank !== undefined) return -1
                    if(b.rank !== undefined) return 1
                    return a.index - b.index
                })
                .map(({ id }) => id),
        })),
    }
}
