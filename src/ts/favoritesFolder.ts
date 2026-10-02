/**
 * The ★ favorites folder (asked for on 2026-10-03): favorite characters that
 * are not in a folder of their own are gathered into one folder with a star
 * glyph at the very top of the list, so the list itself starts with what was
 * just released, restored or imported instead of every favorite.
 *
 * Membership follows the favorite flag. Favoriting a loose character moves it
 * in (newest first), unfavoriting moves it out to the top of the list, and a
 * drag into or out of the folder sets or clears the flag
 * (syncFavoritesWithFolderMoves). Favorites inside a folder the user made
 * stay where they are. Turning the setting off puts the members back in the
 * list where the folder was.
 *
 * Kept free of the app runtime (no stores) so it can be tested directly, and
 * free of characterOrder.ts so that module can import it.
 */
import type { folder } from './storage/database.svelte'

type OrderEntry = string | folder

export const FAVORITES_FOLDER_ID = 'nodeonly-favorites'
export const FAVORITES_FOLDER_MARKER = 'favorites' as const

export function isFavoritesFolder(entry: OrderEntry | null | undefined): entry is folder {
    return !!entry && typeof entry !== 'string'
        && (entry.id === FAVORITES_FOLDER_ID || entry.nodeOnlySystem === FAVORITES_FOLDER_MARKER)
}

export interface FavoritesFolderOptions {
    enabled: boolean
    /** The name a new folder gets (the user may rename it later). */
    name: string
}

/** Gathers the loose favorites into the ★ folder at index 0 (or dissolves it when disabled). */
export function gatherFavoritesFolder(order: OrderEntry[], favoriteIds: ReadonlySet<string>, options: FavoritesFolderOptions): OrderEntry[] {
    const existing = order.find(isFavoritesFolder)
    if (!options.enabled) {
        if (!existing) return order
        return order.flatMap((entry): OrderEntry[] => (entry === existing ? [...existing.data] : [entry]))
    }

    const kept: string[] = []
    const released: string[] = []
    for (const id of existing?.data ?? []) {
        if (favoriteIds.has(id)) kept.push(id)
        else released.push(id)
    }
    const keptSet = new Set(kept)
    const joining: string[] = []
    const rest: OrderEntry[] = []
    for (const entry of order) {
        if (entry === existing) continue
        if (typeof entry === 'string' && favoriteIds.has(entry)) {
            if (!keptSet.has(entry)) joining.push(entry)
            continue
        }
        rest.push(entry)
    }
    const members = [...joining, ...kept]
    if (members.length === 0) return existing ? [...released, ...rest] : order

    const folderEntry: folder = existing
        ? { ...existing, data: members, nodeOnlySystem: FAVORITES_FOLDER_MARKER }
        : {
            id: FAVORITES_FOLDER_ID,
            name: options.name,
            color: 'yellow',
            data: members,
            nodeOnlySystem: FAVORITES_FOLDER_MARKER,
            nodeOnlyIcon: 'star',
            nodeOnlyDisplay: 'icon',
        }
    return [folderEntry, ...released, ...rest]
}

/**
 * A drag (or a "move to folder") into the ★ folder favorites the character;
 * one out of it, to anywhere else in the list, unfavorites it. Without this
 * the next order check would put it straight back. Returns true when a flag
 * changed.
 */
export function syncFavoritesWithFolderMoves(
    previous: readonly OrderEntry[],
    next: readonly OrderEntry[],
    characters: Array<{ chaId: string, favorite?: boolean }>,
): boolean {
    const before = new Set(previous.find(isFavoritesFolder)?.data ?? [])
    const after = new Set(next.find(isFavoritesFolder)?.data ?? [])
    const present = new Set<string>()
    for (const entry of next) {
        if (typeof entry === 'string') present.add(entry)
        else for (const id of entry.data) present.add(id)
    }
    let changed = false
    for (const character of characters) {
        const id = character?.chaId
        if (!id) continue
        if (after.has(id) && !before.has(id) && !character.favorite) {
            character.favorite = true
            changed = true
        } else if (before.has(id) && !after.has(id) && present.has(id) && character.favorite) {
            character.favorite = false
            changed = true
        }
    }
    return changed
}
