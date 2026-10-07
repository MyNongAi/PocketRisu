// The bot list's 🔗 [링크] folder (the user's request, 2026-10-08), the twin of
// the module catalog's (process/linkedModuleFolder.ts): bots that carry
// modules of their own (character.modules) gather there.
//
// Only loose bots move into it. A folder that holds a linked bot is shown
// inside [링크] as it is: the topmost folder it already sits in (a [유사 후보]
// folder shown inside a [제작자] folder brings the [제작자] folder), with the
// display-only nesting of folderNesting.ts. characterOrder stays flat, so a
// Risu build without folders in folders shows [링크] and those folders side
// by side, each with its own bots; nothing is merged or lost. A folder this
// put inside [링크] carries nodeOnlyLinkNested and comes back out when it no
// longer holds a linked bot; one the user put there stays. A bot no longer
// linked leaves [링크] for the top level, right where the folder is.

import type { folder } from './storage/database.svelte'
import { folderParents } from './folderNesting'
import { isFavoritesFolder } from './favoritesFolder'
import { isDeactivatedSystemFolder } from './deactivatedCharacterFolders'

type OrderEntry = string | folder

export const BOT_LINK_FOLDER_NAME = '🔗 [링크]'

function isFolder(entry: OrderEntry): entry is folder {
    return typeof entry !== 'string'
}

function isSystemFolder(entry: folder): boolean {
    return isFavoritesFolder(entry) || isDeactivatedSystemFolder(entry)
}

/** Ids of the bots outside the trash that list modules of their own. */
export function botsWithOwnModules(characters: readonly ({ chaId?: string, modules?: string[], trashTime?: number } | null | undefined)[] | undefined): Set<string> {
    const ids = new Set<string>()
    for (const character of characters ?? []) {
        if (character?.chaId && !character.trashTime && (character.modules?.length ?? 0) > 0) ids.add(character.chaId)
    }
    return ids
}

/** characterOrder after gathering, or null when nothing changes. */
export function gatherLinkedBots(
    order: readonly OrderEntry[],
    linked: ReadonlySet<string>,
    createId: () => string,
): OrderEntry[] | null {
    const folders = order.filter(isFolder)
    const byId = new Map(folders.map((entry) => [entry.id, entry]))
    const link = folders.find((entry) => entry.nodeOnlyLinkFolder)
    const linkId = link?.id ?? createId()
    const parents = folderParents(order)
    const topOf = (id: string): string => {
        let cursor = id
        const seen = new Set<string>()
        while (!seen.has(cursor)) {
            seen.add(cursor)
            const parentId = parents.get(cursor)
            if (!parentId || parentId === linkId) break
            cursor = parentId
        }
        return cursor
    }

    // The folders to show inside [링크]: the top one above each folder holding a linked bot.
    const wanted = new Set<string>()
    for (const entry of folders) {
        if (entry.id === linkId || isSystemFolder(entry) || !entry.data.some((id) => linked.has(id))) continue
        const top = byId.get(topOf(entry.id))
        if (top && top.id !== linkId && !isSystemFolder(top)) wanted.add(top.id)
    }

    const looseLinked = order.filter((entry): entry is string => typeof entry === 'string' && linked.has(entry))
    const kept = (link?.data ?? []).filter((id) => linked.has(id))
    const leaving = (link?.data ?? []).filter((id) => !linked.has(id))
    const linkData = [...looseLinked.filter((id) => !kept.includes(id)), ...kept]
    // A folder the user put inside [링크] keeps it too.
    const userNested = !!link && folders.some((entry) => entry.nodeOnlyParentFolderId === linkId && !entry.nodeOnlyLinkNested)
    const used = linkData.length > 0 || wanted.size > 0 || userNested

    let changed = looseLinked.length > 0 || leaving.length > 0 || (!link && used) || (!!link && !used)
    const next: OrderEntry[] = []
    if (!link && used) {
        next.push({ id: linkId, name: BOT_LINK_FOLDER_NAME, color: '', data: linkData, nodeOnlyLinkFolder: true })
    }
    for (const entry of order) {
        if (typeof entry === 'string') {
            if (!linked.has(entry)) next.push(entry)
            continue
        }
        if (entry.id === linkId) {
            if (used) next.push({ ...entry, data: linkData })
            next.push(...leaving)
            continue
        }
        if (wanted.has(entry.id) && entry.nodeOnlyParentFolderId !== linkId) {
            changed = true
            next.push({ ...entry, nodeOnlyParentFolderId: linkId, nodeOnlyLinkNested: true })
            continue
        }
        if (!wanted.has(entry.id) && entry.nodeOnlyLinkNested) {
            changed = true
            const { nodeOnlyLinkNested: _flag, ...rest } = entry
            if (rest.nodeOnlyParentFolderId === linkId) delete rest.nodeOnlyParentFolderId
            next.push(rest)
            continue
        }
        next.push(entry)
    }
    return changed ? next : null
}
