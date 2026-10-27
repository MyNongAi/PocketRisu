/**
 * Folders inside folders, for the sidebar rail only (asked for on 2026-10-03).
 *
 * `characterOrder` stays flat: every folder remains a top-level entry with its
 * own characters, exactly where it was. A nested folder only carries the id of
 * the folder it is shown in (`nodeOnlyParentFolderId`), and the rail draws it
 * inside that folder. Other Risu builds ignore the field and show every folder
 * side by side, as before, so nothing is lost or moved for them.
 *
 * The field is a display hint, so it is resolved defensively: a parent that no
 * longer exists, a system folder (★ favorites, the idle-age folders) on either
 * side, or a loop (A in B in A) makes the folder show at the top level again.
 */
import type { folder } from './storage/database.svelte'
import { isFavoritesFolder } from './favoritesFolder'
import { isDeactivatedSystemFolder } from './deactivatedCharacterFolders'
import type { OrderEntry } from './characterOrder'

// Local, so characterOrder.ts can import this module without a cycle.
function isFolderEntry(entry: OrderEntry | null | undefined): entry is folder {
    return !!entry && typeof entry !== 'string'
}

function isSystemFolder(entry: folder): boolean {
    return isDeactivatedSystemFolder(entry) || isFavoritesFolder(entry)
}

/** child folder id -> the folder it is shown in, for the nestings that hold. */
export function folderParents(order: readonly OrderEntry[]): Map<string, string> {
    const folders = new Map<string, folder>()
    for (const entry of order) if (isFolderEntry(entry) && entry.id) folders.set(entry.id, entry)
    const declared = (id: string): string | undefined => {
        const entry = folders.get(id)
        const parentId = entry?.nodeOnlyParentFolderId
        if (!entry || !parentId || parentId === id || isSystemFolder(entry)) return undefined
        const parent = folders.get(parentId)
        return parent && !isSystemFolder(parent) ? parentId : undefined
    }
    const parents = new Map<string, string>()
    for (const id of folders.keys()) {
        const parentId = declared(id)
        if (!parentId) continue
        // Walk up; a folder that reaches itself is in a loop and stays on top.
        const seen = new Set([id])
        let cursor: string | undefined = parentId
        let looped = false
        while (cursor) {
            if (seen.has(cursor)) { looped = true; break }
            seen.add(cursor)
            cursor = declared(cursor)
        }
        if (!looped) parents.set(id, parentId)
    }
    return parents
}

/** parent folder id -> its child folder ids, in characterOrder order. */
export function folderChildren(order: readonly OrderEntry[]): Map<string, string[]> {
    const parents = folderParents(order)
    const children = new Map<string, string[]>()
    for (const entry of order) {
        if (!isFolderEntry(entry)) continue
        const parentId = parents.get(entry.id)
        if (!parentId) continue
        const list = children.get(parentId)
        if (list) list.push(entry.id)
        else children.set(parentId, [entry.id])
    }
    return children
}

function descendants(order: readonly OrderEntry[], folderId: string): Set<string> {
    const children = folderChildren(order)
    const found = new Set<string>()
    const stack = [...(children.get(folderId) ?? [])]
    while (stack.length > 0) {
        const id = stack.pop()!
        if (found.has(id)) continue
        found.add(id)
        stack.push(...(children.get(id) ?? []))
    }
    return found
}

/** Folders `folderId` may be put in: not itself, not one inside it, no system folder. */
export function nestableParents(order: readonly OrderEntry[], folderId: string): folder[] {
    const self = order.find((entry): entry is folder => isFolderEntry(entry) && entry.id === folderId)
    if (!self || isSystemFolder(self)) return []
    const inside = descendants(order, folderId)
    return order.filter((entry): entry is folder => (
        isFolderEntry(entry) && entry.id !== folderId && !inside.has(entry.id) && !isSystemFolder(entry)
    ))
}

/**
 * Show `folderId` inside `parentId`, or at the top level with null. Returns a
 * new order (the folder keeps its place in it), or null when the change is
 * not allowed or changes nothing.
 */
export function setFolderParent(order: readonly OrderEntry[], folderId: string, parentId: string | null): OrderEntry[] | null {
    const index = order.findIndex((entry) => isFolderEntry(entry) && entry.id === folderId)
    if (index < 0) return null
    const current = order[index] as folder
    if (parentId !== null && !nestableParents(order, folderId).some((entry) => entry.id === parentId)) return null
    if ((current.nodeOnlyParentFolderId ?? null) === parentId) return null
    const next = order.slice()
    const updated: folder = { ...current, data: [...current.data] }
    if (parentId === null) delete updated.nodeOnlyParentFolderId
    else updated.nodeOnlyParentFolderId = parentId
    next[index] = updated
    return next
}

/** The folders `folderId` is shown in, innermost first (empty at the top level). */
export function folderAncestors(order: readonly OrderEntry[], folderId: string): string[] {
    const parents = folderParents(order)
    const chain: string[] = []
    let cursor = parents.get(folderId)
    while (cursor && !chain.includes(cursor)) {
        chain.push(cursor)
        cursor = parents.get(cursor)
    }
    return chain
}

/**
 * Where the folders shown inside a parent go among the parent's own bots, so
 * the inside of a folder reads by recency like the top level (the user's
 * report, 2026-10-21: the folders inside always sat on top, like favorites).
 * A folder goes after the last member used at least as recently as anything
 * in it. `slots[i]` holds the folders drawn just before member i, and
 * `slots[memberRecency.length]` the ones after the last; folders sharing a
 * slot go newest first, then in the given order.
 */
export function interleaveFolderSlots<T>(memberRecency: readonly number[], children: readonly { item: T, recency: number }[]): T[][] {
    const slots: T[][] = Array.from({ length: memberRecency.length + 1 }, () => [])
    const placed = children.map((child, order) => {
        let slot = 0
        for (let i = 0; i < memberRecency.length; i++) if (memberRecency[i] >= child.recency) slot = i + 1
        return { child, order, slot }
    })
    placed.sort((a, b) => a.slot - b.slot || b.child.recency - a.child.recency || a.order - b.order)
    for (const { child, slot } of placed) slots[slot].push(child.item)
    return slots
}

/**
 * The recency the rail interleaves by: each bot's lastInteraction, which
 * opening it stamps. The list moves as a bot is opened (2026-10-28; before,
 * only once it was left, and the open bot kept the value it had before).
 */
export function railRecencySnapshot(
    characters: Iterable<{ chaId?: string, lastInteraction?: number } | null | undefined>,
): Map<string, number> {
    const next = new Map<string, number>()
    for (const character of characters) {
        const id = character?.chaId
        if (!id) continue
        const stamped = Number(character.lastInteraction ?? 0)
        next.set(id, Number.isFinite(stamped) ? stamped : 0)
    }
    return next
}

/** Whether some folder is shown inside `folderId`. */
export function hasChildFolders(order: readonly OrderEntry[], folderId: string): boolean {
    return folderChildren(order).has(folderId)
}

/**
 * When `removedId` goes away, the folders shown in it move up one level (to
 * its own parent, or the top level).
 */
export function reparentChildrenOf(order: OrderEntry[], removedId: string): OrderEntry[] {
    const removed = order.find((entry): entry is folder => isFolderEntry(entry) && entry.id === removedId)
    const grandparent = removed?.nodeOnlyParentFolderId
    return order.map((entry) => {
        if (!isFolderEntry(entry) || entry.nodeOnlyParentFolderId !== removedId) return entry
        const updated: folder = { ...entry, data: [...entry.data] }
        if (grandparent && grandparent !== entry.id) updated.nodeOnlyParentFolderId = grandparent
        else delete updated.nodeOnlyParentFolderId
        return updated
    })
}
