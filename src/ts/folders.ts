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
 * The folder `folder` is shown inside (display only, `nodeOnlyParentFolderId`),
 * one level deep as FolderedList draws it: a parent that is gone, the folder
 * itself or a parent that is itself inside another leaves it at the top.
 */
export function shownInside(
    folder: PromptPresetFolder | null | undefined,
    folders: readonly PromptPresetFolder[],
): string | undefined {
    const parentId = folder?.nodeOnlyParentFolderId
    if (!parentId || parentId === folder.id) return undefined
    return folders.some((candidate) => candidate.id === parentId && !candidate.nodeOnlyParentFolderId) ? parentId : undefined
}

/** The folders in display order: each top-level folder, then the ones inside it. */
export function folderTree(folders: readonly PromptPresetFolder[]): { folder: PromptPresetFolder, depth: 0 | 1 }[] {
    return nestGroups(folders.map((folder) => ({ folder })), folders)
        .map(({ group, depth }) => ({ folder: group.folder, depth }))
}

/**
 * `groups` in display order for a list that draws folders in folders by
 * indenting: each group, then the groups shown inside its folder (depth 1).
 * A group whose parent is not among `groups` stays where it was.
 */
export function nestGroups<G extends { folder: PromptPresetFolder | null }>(
    groups: readonly G[],
    folders: readonly PromptPresetFolder[],
): { group: G, depth: 0 | 1 }[] {
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
    const out: { group: G, depth: 0 | 1 }[] = []
    for (const group of groups) {
        if (parentOf(group)) continue
        out.push({ group, depth: 0 })
        for (const child of group.folder ? (children.get(group.folder.id) ?? []) : []) out.push({ group: child, depth: 1 })
    }
    return out
}
