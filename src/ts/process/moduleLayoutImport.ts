import { folderDepth, shownInside } from '../folders'
import {
    dissolveShrunkenModuleFolders,
    normalizeModuleFolders,
    synchronizeModuleFolderMembership,
    type FolderableModule,
    type ModuleFolder,
} from './moduleFolders'

// A module folder layout, imported from a file through the module list's
// import button (the user's request, 2026-10-28: "모듈은 원작별로 모아줘 /
// 2차면 2차 폴더 하위에 / Zzz, 붕괴 이런거"). Telling the source work of
// hundreds of modules took reading their names and asset names, so the
// sorting is made outside the app and comes back as a file, as recovered chats
// do: nothing writes the save behind the server. The file names modules and
// folders by id and where they go by a path of folder names; a folder on the
// path that does not exist yet is made. Only folder places change: no module
// is added, edited or removed.

export const MODULE_LAYOUT_TYPE = 'pocketrisuModuleLayout'

/** Deepest a folder may sit, as the module list lets the user nest (ModuleSettings). */
export const MODULE_LAYOUT_MAX_DEPTH = 5

export interface ModuleLayoutMove {
    /** A module to put in the folder at `to`. */
    module?: string
    /** Or a folder to show inside the folder at `to`, with all it holds. */
    folder?: string
    /** Folder names from the top; [] is the top level. */
    to: string[]
}

export interface ModuleLayoutFile {
    type: typeof MODULE_LAYOUT_TYPE
    ver: 1
    moves: ModuleLayoutMove[]
}

export interface ModuleLayoutResult<T extends FolderableModule> {
    modules: T[]
    folders: ModuleFolder[]
    movedModules: number
    movedFolders: number
    createdFolders: number
    /** Moves naming a module or folder that is not there, or a place it cannot go. */
    skipped: number
}

export function isModuleLayoutFile(value: unknown): value is ModuleLayoutFile {
    const raw = value as Partial<ModuleLayoutFile> | null
    return !!raw && typeof raw === 'object' && raw.type === MODULE_LAYOUT_TYPE && Array.isArray(raw.moves)
}

// [링크], [프롬] and [유사 후보] folders are kept by their own rules; a path
// never reaches into one.
function isManagedFolder(folder: ModuleFolder): boolean {
    return !!folder.nodeOnlyLinkFolder || !!folder.nodeOnlyPresetFolder || !!folder.duplicateCandidate
}

export function applyModuleLayout<T extends FolderableModule>(
    modules: readonly T[],
    folders: unknown,
    layout: ModuleLayoutFile,
    createId: () => string,
): ModuleLayoutResult<T> {
    const previous = normalizeModuleFolders(folders)
    let nextFolders = previous.map((folder) => ({ ...folder }))
    const nextModules = [...modules]
    const moduleIndex = new Map(nextModules.map((module, index) => [module.id, index]))
    let movedModules = 0
    let movedFolders = 0
    let createdFolders = 0
    let skipped = 0
    const created = new Set<string>()

    const byId = () => new Map(nextFolders.map((folder) => [folder.id, folder]))
    const depthOf = (id: string | undefined) => {
        const folder = id ? byId().get(id) : undefined
        return folder ? folderDepth(folder, nextFolders) + 1 : 0
    }
    // The folder at `path`, made where missing; null when it would be too deep.
    const resolve = (path: string[]): string | undefined | null => {
        let parent: string | undefined
        for (const segment of path) {
            const name = String(segment ?? '').trim()
            if (!name) return null
            const found = nextFolders.find((folder) => folder.name.trim() === name
                && !isManagedFolder(folder)
                && shownInside(folder, nextFolders) === parent)
            if (found) {
                parent = found.id
                continue
            }
            if (depthOf(parent) >= MODULE_LAYOUT_MAX_DEPTH) return null
            const folder: ModuleFolder = { id: createId(), name, moduleIds: [] }
            if (parent) folder.nodeOnlyParentFolderId = parent
            nextFolders.push(folder)
            created.add(folder.id)
            createdFolders++
            parent = folder.id
        }
        return parent
    }
    const descendantsOf = (id: string) => {
        const found = new Set<string>()
        const stack = [id]
        while (stack.length > 0) {
            const current = stack.pop()!
            for (const folder of nextFolders) {
                if (!found.has(folder.id) && shownInside(folder, nextFolders) === current) {
                    found.add(folder.id)
                    stack.push(folder.id)
                }
            }
        }
        return found
    }

    for (const move of layout.moves) {
        if (!move || !Array.isArray(move.to)) { skipped++; continue }
        if (typeof move.module === 'string') {
            const index = moduleIndex.get(move.module)
            const target = index === undefined ? null : resolve(move.to)
            if (index === undefined || target === null) { skipped++; continue }
            if ((nextModules[index].folderId || undefined) === target) continue
            nextModules[index] = { ...nextModules[index], folderId: target }
            movedModules++
            continue
        }
        if (typeof move.folder === 'string') {
            const folder = byId().get(move.folder)
            if (!folder || folder.nodeOnlyLinkFolder || folder.nodeOnlyPresetFolder) { skipped++; continue }
            const below = descendantsOf(folder.id)
            const height = Math.max(0, ...[...below].map((id) => depthOf(id) - depthOf(folder.id)))
            const target = resolve(move.to)
            if (target === null || target === folder.id || (target && below.has(target))
                || depthOf(target) + 1 + height > MODULE_LAYOUT_MAX_DEPTH) { skipped++; continue }
            if (shownInside(folder, nextFolders) === target) continue
            nextFolders = nextFolders.map((candidate) => {
                if (candidate.id !== folder.id) return candidate
                const { nodeOnlyParentFolderId: _dropped, ...rest } = candidate
                return target ? { ...rest, nodeOnlyParentFolderId: target } : rest
            })
            movedFolders++
            continue
        }
        skipped++
    }

    // A folder made for a move that was then skipped holds nothing.
    for (let dropped = true; dropped; ) {
        const used = new Set<string>()
        for (const module of nextModules) if (module.folderId) used.add(module.folderId)
        for (const folder of nextFolders) {
            const parent = shownInside(folder, nextFolders)
            if (parent) used.add(parent)
        }
        const before = nextFolders.length
        nextFolders = nextFolders.filter((folder) => used.has(folder.id) || !created.has(folder.id))
        dropped = nextFolders.length < before
        createdFolders -= before - nextFolders.length
    }

    const synchronized = synchronizeModuleFolderMembership(nextModules, nextFolders, { importLegacyWhenFolderIdsEmpty: false })
    // A folder emptied to one module goes, as after a drag.
    const dissolved = dissolveShrunkenModuleFolders(nextModules, synchronized, previous)
    return { ...dissolved, movedModules, movedFolders, createdFolders, skipped }
}
