import type { PromptPresetFolder } from './storage/database.svelte'

export interface FolderGroup {
    /** `null` for the uncategorized group. */
    folder: PromptPresetFolder | null
    /** Indexes into the original item array, in original order. */
    indexes: number[]
}

/** The saved set records deviations from the default; uncategorized stays open. */
export function isFolderCollapsed(folderId: string, toggled: ReadonlySet<string>, defaultCollapsed = false): boolean {
    return defaultCollapsed && folderId !== '' ? !toggled.has(folderId) : toggled.has(folderId)
}

/**
 * Groups item indexes by folder. Items whose folderId points to a missing
 * folder are treated as uncategorized so nothing silently disappears from
 * the UI. Folder order follows `folders`; the uncategorized group is last.
 */
export function groupByFolder(
    itemFolderIds: (string | undefined | null)[],
    folders: PromptPresetFolder[],
): FolderGroup[] {
    const byId = new Map<string, number[]>()
    for (const folder of folders) byId.set(folder.id, [])
    const uncategorized: number[] = []
    itemFolderIds.forEach((folderId, index) => {
        const bucket = folderId ? byId.get(folderId) : undefined
        if (bucket) bucket.push(index)
        else uncategorized.push(index)
    })
    return [
        ...folders.map(folder => ({ folder, indexes: byId.get(folder.id) ?? [] })),
        { folder: null, indexes: uncategorized },
    ]
}

/**
 * The folder `folder` is shown inside (display only, `nodeOnlyParentFolderId`).
 * Folders nest to any depth (FolderedList limits how deep a list lets the user
 * go, by `maxFolderDepth`); a parent that is gone, the folder itself or a
 * loop up the chain (A in B in A) leaves it at the top.
 */
export function shownInside(
    folder: PromptPresetFolder | null | undefined,
    folders: readonly PromptPresetFolder[],
): string | undefined {
    const parentId = folder?.nodeOnlyParentFolderId
    if (!folder || !parentId || parentId === folder.id) return undefined
    const byId = new Map(folders.map((candidate) => [candidate.id, candidate] as const))
    if (!byId.has(parentId)) return undefined
    const seen = new Set([folder.id])
    for (let cursor: string | undefined = parentId; cursor; ) {
        if (seen.has(cursor)) return undefined
        seen.add(cursor)
        const next: string | undefined = byId.get(cursor)?.nodeOnlyParentFolderId
        cursor = next && byId.has(next) ? next : undefined
    }
    return parentId
}

/** How many folders `folder` is shown inside (0 at the top). */
export function folderDepth(folder: PromptPresetFolder, folders: readonly PromptPresetFolder[]): number {
    const byId = new Map(folders.map((candidate) => [candidate.id, candidate] as const))
    let depth = 0
    for (let parentId = shownInside(folder, folders); parentId; parentId = shownInside(byId.get(parentId), folders)) depth++
    return depth
}

/** The folders in display order: each folder, then the ones inside it, depth first. */
export function folderTree(folders: readonly PromptPresetFolder[]): { folder: PromptPresetFolder, depth: number }[] {
    return nestGroups(folders.map((folder) => ({ folder })), folders)
        .map(({ group, depth }) => ({ folder: group.folder, depth }))
}

/**
 * `groups` in display order for a list that draws folders in folders by
 * indenting: each group, then the groups shown inside its folder (one deeper),
 * depth first. A group whose parent is not among `groups` stays where it was.
 */
export function nestGroups<G extends { folder: PromptPresetFolder | null }>(
    groups: readonly G[],
    folders: readonly PromptPresetFolder[],
): { group: G, depth: number }[] {
    const present = new Set(groups.map((group) => group.folder?.id).filter(Boolean))
    const parentOf = (group: G) => {
        const parentId = shownInside(group.folder, folders)
        return parentId && present.has(parentId) ? parentId : undefined
    }
    const children = new Map<string, G[]>()
    for (const group of groups) {
        const parentId = parentOf(group)
        if (parentId) children.set(parentId, [...(children.get(parentId) ?? []), group])
    }
    const out: { group: G, depth: number }[] = []
    const placed = new Set<G>()
    const visit = (group: G, depth: number) => {
        if (placed.has(group)) return
        placed.add(group)
        out.push({ group, depth })
        for (const child of group.folder ? (children.get(group.folder.id) ?? []) : []) visit(child, depth + 1)
    }
    for (const group of groups) if (!parentOf(group)) visit(group, 0)
    return out
}
