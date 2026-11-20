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
// gather in [링크] folders of the module catalog (the user's request,
// 2026-10-07; the bot list has the same, linkedBotFolder.ts). Only loose
// modules move: one from a Proton share (the large asset modules a Realm card
// links, fetched by themselves) into [링크], any other (linked by hand) into
// [링크2] (2026-10-23). A module in a folder of the user's stays there, and
// the folder stays where it is; it carried the whole folder into [링크] before
// (2026-10-08), which took it out of its place in 최근순.
// Linked modules with near-duplicate names that sit loose in a link folder get
// their own [유사 후보] folder inside it. A module no bot links any more leaves
// its link folder for the top level, and an empty link folder goes.
// 2026-11-20: two gatherable modules linked by the same set of bots sit in a
// top-level [링크 : 봇 제목, ...] folder, tracked by nodeOnlyLinkBotIds.

export const LINK_FOLDER_NAME = '[링크]'
export const MANUAL_LINK_FOLDER_NAME = '[링크2]'
// Names follow the order of DBState.db.characters.
export const botLinkFolderName = (names: readonly string[]) => `[링크 : ${names.map((name) => name.trim() || '이름 없음').join(', ')}]`
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

type GatherModule = FolderableModule & {
    sourceInfo?: { label?: string }
    nodeOnlyProtonShare?: string
    nodeOnlyProtonSource?: unknown
}

type LinkKind = 'auto' | 'manual'

/** [링크] for modules from a Proton share, [링크2] for the rest. */
export function linkKindOf(module: { nodeOnlyProtonShare?: string, nodeOnlyProtonSource?: unknown }): LinkKind {
    return module.nodeOnlyProtonShare || module.nodeOnlyProtonSource ? 'auto' : 'manual'
}

function folderKind(folder: ModuleFolder): LinkKind | null {
    if (!folder.nodeOnlyLinkFolder || folder.nodeOnlyLinkBotIds) return null
    return folder.nodeOnlyLinkKind === 'manual' ? 'manual' : 'auto'
}

/**
 * The catalog after gathering, or null when nothing changes. A link folder is
 * made at the top when first needed (first in 최근순 too, as the module in it
 * was just linked) and removed when nothing is in or under it. A moved module
 * is a new object, so the save tracker sees only those.
 */
export function gatherLinkedModules<T extends GatherModule>(
    modules: readonly T[],
    folders: unknown,
    linked: ReadonlySet<string>,
    createId: () => string,
    characters: readonly ({ chaId?: string, name?: string, modules?: string[], trashTime?: number } | null | undefined)[] = [],
): { modules: T[], folders: ModuleFolder[] } | null {
    const current = normalizeModuleFolders(folders)
    const byId = new Map(current.map((folder) => [folder.id, folder]))
    const existing: Record<LinkKind, ModuleFolder | undefined> = {
        auto: current.find((folder) => folderKind(folder) === 'auto'),
        manual: current.find((folder) => folderKind(folder) === 'manual'),
    }
    const linkIds: Record<LinkKind, string> = {
        auto: existing.auto?.id ?? '',
        manual: existing.manual?.id ?? '',
    }
    const linkIdFor = (kind: LinkKind) => (linkIds[kind] ||= createId())
    let changed = false

    const activeBots = characters.filter((bot): bot is NonNullable<typeof bot> => !!bot?.chaId && !bot.trashTime)
    const owners = new Map<string, string[]>()
    for (const bot of activeBots) for (const id of new Set(bot.modules ?? [])) {
        const ids = owners.get(id) ?? []
        if (!ids.includes(bot.chaId!)) owners.set(id, [...ids, bot.chaId!])
    }
    const botSetKey = (ids: readonly string[]) => JSON.stringify([...ids].sort())
    const botFolders = new Map(current.filter((folder) => folder.nodeOnlyLinkBotIds).map((folder) => [botSetKey(folder.nodeOnlyLinkBotIds!), folder]))

    // The link folder a folder belongs to: itself, or the one a generated
    // [유사 후보] folder sits in.
    const areaOf = (folder: ModuleFolder | undefined): LinkKind | null => {
        if (!folder) return null
        const own = folderKind(folder)
        if (own) return own
        const parent = folder.duplicateCandidate && folder.nodeOnlyParentFolderId ? byId.get(folder.nodeOnlyParentFolderId) : undefined
        return parent ? folderKind(parent) : null
    }

    const eligible = (module: T) => {
        const folder = module.folderId ? byId.get(module.folderId) : undefined
        return !folder || !!areaOf(folder) || !!folder.nodeOnlyLinkBotIds
    }
    const botGroups = new Map<string, { ids: string[], count: number }>()
    for (const module of modules) {
        if (!linked.has(module.id) || !eligible(module)) continue
        const ids = owners.get(module.id)
        if (!ids?.length) continue
        const key = botSetKey(ids)
        const group = botGroups.get(key)
        if (group) group.count++
        else botGroups.set(key, { ids, count: 1 })
    }
    const botTargets = new Map([...botGroups].filter(([, group]) => group.count >= 2)
        .map(([key, group]) => [key, botFolders.get(key)?.id ?? createId()]))

    let nextModules = modules.map((module) => {
        const folder = module.folderId ? byId.get(module.folderId) : undefined
        const area = areaOf(folder)
        if (linked.has(module.id)) {
            const owner = owners.get(module.id)
            // A module in a folder of the user's stays there (and was not counted).
            const botTarget = owner?.length && eligible(module) ? botTargets.get(botSetKey(owner)) : undefined
            if (botTarget) {
                if (module.folderId === botTarget) return module
                changed = true
                return { ...module, folderId: botTarget }
            }
            const kind = linkKindOf(module)
            if (folder && !folder.nodeOnlyLinkBotIds && (!area || area === kind)) return module
            changed = true
            return { ...module, folderId: linkIdFor(kind) }
        }
        if (folder && (folderKind(folder) || folder.nodeOnlyLinkBotIds)) {
            changed = true
            return { ...module, folderId: undefined }
        }
        return module
    })

    // Near-duplicates loose in a link folder get a [유사 후보] folder inside it.
    const created: ModuleFolder[] = []
    for (const linkId of [linkIds.auto, linkIds.manual].filter(Boolean)) {
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
    }

    const holdsLinked = new Set(nextModules.filter((module) => linked.has(module.id) && module.folderId).map((module) => module.folderId!))
    let nextFolders: ModuleFolder[] = current.map((folder) => {
        if (folderKind(folder) === 'auto' && folder.name === LEGACY_LINK_FOLDER_NAME) {
            changed = true
            return { ...folder, name: LINK_FOLDER_NAME }
        }
        const parent = folder.nodeOnlyParentFolderId ? byId.get(folder.nodeOnlyParentFolderId) : undefined
        // In a link folder only its own [유사 후보] folders stay, while they
        // hold a linked module; a folder of the user's comes back out.
        if (parent?.nodeOnlyLinkFolder && !(folder.duplicateCandidate && folderKind(parent) && holdsLinked.has(folder.id))) {
            changed = true
            const { nodeOnlyParentFolderId: _dropped, ...rest } = folder
            return rest
        }
        return folder
    })
    nextFolders = [...created, ...nextFolders]

    const explicitOrders = current.map((folder) => folder.sortOrder).filter((order): order is number => Number.isFinite(order))
    let top = explicitOrders.length > 0 ? Math.min(...explicitOrders) : undefined
    const names = new Map(activeBots.map((bot) => [bot.chaId!, bot.name ?? '']))
    for (const [key, id] of botTargets) {
        const ids = botGroups.get(key)!.ids
        const name = botLinkFolderName(ids.map((botId) => names.get(botId) ?? ''))
        const existingBotFolder = botFolders.get(key)
        if (!existingBotFolder) {
            nextFolders = [{ id, name, moduleIds: [], nodeOnlyLinkFolder: true, nodeOnlyLinkBotIds: ids, ...(top !== undefined ? { sortOrder: --top } : {}) }, ...nextFolders]
            changed = true
        } else if (existingBotFolder.name !== name || existingBotFolder.nodeOnlyParentFolderId
            || JSON.stringify(existingBotFolder.nodeOnlyLinkBotIds) !== JSON.stringify(ids)) {
            nextFolders = nextFolders.map((folder) => folder.id === id ? { ...folder, name, nodeOnlyLinkBotIds: ids, nodeOnlyParentFolderId: undefined } : folder)
            changed = true
        }
    }
    for (const [key, folder] of botFolders) if (!botTargets.has(key)) {
        nextFolders = nextFolders.filter((entry) => entry.id !== folder.id)
        changed = true
    }
    for (const kind of ['manual', 'auto'] as const) {
        const linkId = linkIds[kind]
        if (!linkId) continue
        const used = nextModules.some((module) => module.folderId === linkId)
            || nextFolders.some((folder) => folder.nodeOnlyParentFolderId === linkId)
        if (!existing[kind] && used) {
            const folder: ModuleFolder = {
                id: linkId,
                name: kind === 'auto' ? LINK_FOLDER_NAME : MANUAL_LINK_FOLDER_NAME,
                moduleIds: [],
                nodeOnlyLinkFolder: true,
                ...(kind === 'manual' ? { nodeOnlyLinkKind: 'manual' as const } : {}),
                // Folders ordered by hand or by activation keep a sortOrder;
                // a new one without would sink to the bottom.
                ...(top !== undefined ? { sortOrder: --top } : {}),
            }
            nextFolders = [folder, ...nextFolders]
            changed = true
        } else if (existing[kind] && !used) {
            nextFolders = nextFolders.filter((folder) => folder.id !== linkId)
            changed = true
        }
    }
    if (!changed) return null

    const linkFolderIds = new Set([...botTargets.values(), linkIds.auto, linkIds.manual].filter(Boolean))
    const synchronized = synchronizeModuleFolderMembership(nextModules, nextFolders, { importLegacyWhenFolderIdsEmpty: false })
    // A generated folder that lost its members to a link folder goes, as
    // after a drag; a link folder itself stays while anything is in or under it.
    return dissolveShrunkenModuleFolders(nextModules, synchronized, current.filter((folder) => !linkFolderIds.has(folder.id)))
}
