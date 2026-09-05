import type { folder } from 'src/ts/storage/database.svelte'

/**
 * Stable-ID sidebar order transforms adapted from the design in PocketRisu Kei
 * commit 114dbfc7 (GPL-3.0). DOM/touch handlers only describe intent; this
 * module owns validation, cloning, removal, and insertion without mutating DB.
 */

export type SidebarOrder = ReadonlyArray<string | folder>

export type SidebarDragItem =
    | { kind: 'character', id: string }
    | { kind: 'folder', id: string }

export type SidebarInsertTarget =
    | { kind: 'root', index: number }
    | { kind: 'folder', folderId: string, index: number }

export type SidebarItemTarget =
    | { kind: 'character', id: string }
    | { kind: 'folder', id: string }

type CharacterLocation =
    | { kind: 'root', index: number }
    | { kind: 'folder', folderIndex: number, memberIndex: number, folderId: string }

function cloneSidebarOrder(order: SidebarOrder): Array<string | folder> {
    return order.map((item) => typeof item === 'string'
        ? item
        : { ...item, data: [...item.data] })
}

function validIndex(index: number): boolean {
    return Number.isInteger(index) && index >= 0
}

function characterLocations(order: SidebarOrder, characterId: string): CharacterLocation[] {
    const locations: CharacterLocation[] = []
    for (let index = 0; index < order.length; index += 1) {
        const item = order[index]
        if (typeof item === 'string') {
            if (item === characterId) locations.push({ kind: 'root', index })
            continue
        }
        for (let memberIndex = 0; memberIndex < item.data.length; memberIndex += 1) {
            if (item.data[memberIndex] === characterId) {
                locations.push({ kind: 'folder', folderIndex: index, memberIndex, folderId: item.id })
            }
        }
    }
    return locations
}

function uniqueCharacterLocation(order: SidebarOrder, characterId: string): CharacterLocation | null {
    if (!characterId) return null
    const locations = characterLocations(order, characterId)
    return locations.length === 1 ? locations[0] : null
}

function folderIndex(order: SidebarOrder, id: string): number {
    if (!id) return -1
    return order.findIndex((item) => typeof item !== 'string' && item.id === id)
}

function removeCharacterAt(order: Array<string | folder>, location: CharacterLocation): boolean {
    if (location.kind === 'root') {
        if (order[location.index] === undefined || typeof order[location.index] !== 'string') return false
        order.splice(location.index, 1)
        return true
    }
    const item = order[location.folderIndex]
    if (typeof item === 'string' || item?.id !== location.folderId) return false
    if (item.data[location.memberIndex] === undefined) return false
    item.data.splice(location.memberIndex, 1)
    return true
}

/** Move one character or whole folder using a stable source ID. */
export function moveSidebarItem(
    currentOrder: SidebarOrder,
    source: SidebarDragItem,
    target: SidebarInsertTarget,
): Array<string | folder> | null {
    if (!source.id || !validIndex(target.index)) return null

    if (source.kind === 'folder') {
        if (target.kind !== 'root') return null
        const sourceIndex = folderIndex(currentOrder, source.id)
        if (sourceIndex < 0) return null

        const nextOrder = cloneSidebarOrder(currentOrder)
        const [moving] = nextOrder.splice(sourceIndex, 1)
        if (!moving || typeof moving === 'string') return null
        const adjustedIndex = sourceIndex < target.index ? target.index - 1 : target.index
        nextOrder.splice(Math.min(adjustedIndex, nextOrder.length), 0, moving)
        return nextOrder
    }

    const sourceLocation = uniqueCharacterLocation(currentOrder, source.id)
    if (!sourceLocation) return null
    if (target.kind === 'folder' && folderIndex(currentOrder, target.folderId) < 0) return null

    const nextOrder = cloneSidebarOrder(currentOrder)
    if (!removeCharacterAt(nextOrder, sourceLocation)) return null

    if (target.kind === 'root') {
        const adjustedIndex = sourceLocation.kind === 'root' && sourceLocation.index < target.index
            ? target.index - 1
            : target.index
        nextOrder.splice(Math.min(adjustedIndex, nextOrder.length), 0, source.id)
        return nextOrder
    }

    const destinationIndex = folderIndex(nextOrder, target.folderId)
    if (destinationIndex < 0) return null
    const destination = nextOrder[destinationIndex]
    if (typeof destination === 'string') return null
    const adjustedIndex = sourceLocation.kind === 'folder'
        && sourceLocation.folderId === target.folderId
        && sourceLocation.memberIndex < target.index
        ? target.index - 1
        : target.index
    destination.data.splice(Math.min(adjustedIndex, destination.data.length), 0, source.id)
    return nextOrder
}

/**
 * Drop a character on a root character to create a folder, or on a folder to
 * append it. Dropping a folder on another item never creates nested folders.
 */
export function applySidebarItemDrop(
    currentOrder: SidebarOrder,
    source: SidebarDragItem,
    target: SidebarItemTarget,
    createFolder: () => Omit<folder, 'data'>,
): Array<string | folder> | null {
    if (source.kind !== 'character' || !source.id || source.id === target.id) return null
    if (!uniqueCharacterLocation(currentOrder, source.id)) return null

    if (target.kind === 'folder') {
        const targetIndex = folderIndex(currentOrder, target.id)
        if (targetIndex < 0) return null
        const targetFolder = currentOrder[targetIndex]
        if (typeof targetFolder === 'string') return null
        return moveSidebarItem(currentOrder, source, {
            kind: 'folder',
            folderId: target.id,
            index: targetFolder.data.length,
        })
    }

    const targetLocation = uniqueCharacterLocation(currentOrder, target.id)
    if (!targetLocation || targetLocation.kind !== 'root') return null
    const nextOrder = cloneSidebarOrder(currentOrder)
    const sourceLocation = uniqueCharacterLocation(nextOrder, source.id)
    if (!sourceLocation || !removeCharacterAt(nextOrder, sourceLocation)) return null
    const targetIndex = nextOrder.findIndex((item) => item === target.id)
    if (targetIndex < 0) return null

    const created = createFolder()
    if (!created.id || folderIndex(nextOrder, created.id) >= 0) return null
    nextOrder[targetIndex] = {
        ...created,
        data: [source.id, target.id],
    }
    return nextOrder
}
