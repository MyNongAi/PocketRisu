import type { folder } from './storage/database.svelte'

export type CharacterOrderEntry = string | folder
export type CharacterFavoriteIds = ReadonlySet<string>

function folderHasFavoriteCharacter(entry: folder, favoriteIds: CharacterFavoriteIds): boolean {
    return entry.data.some((id) => favoriteIds.has(id))
}

function entryIsFavorite(entry: CharacterOrderEntry, favoriteIds: CharacterFavoriteIds): boolean {
    return typeof entry === 'string'
        ? favoriteIds.has(entry)
        : !!entry.favorite || folderHasFavoriteCharacter(entry, favoriteIds)
}

function stableFavoritePartition<T>(
    values: readonly T[],
    isFavorite: (value: T) => boolean,
): T[] {
    const favorites: T[] = []
    const regular: T[] = []
    let sawRegular = false
    let needsReorder = false

    for (const value of values) {
        if (isFavorite(value)) {
            favorites.push(value)
            if (sawRegular) needsReorder = true
        }
        else {
            regular.push(value)
            sawRegular = true
        }
    }

    return needsReorder ? [...favorites, ...regular] : values.slice()
}

function sameEntries<T>(left: readonly T[], right: readonly T[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Keeps pinned characters and folders in a stable top section. A folder is
 * considered pinned when the folder itself or at least one of its children is
 * pinned. Pinned children likewise stay above regular children in that folder.
 */
export function normalizeCharacterFavoriteOrder(
    order: CharacterOrderEntry[],
    favoriteIds: CharacterFavoriteIds = new Set(),
): CharacterOrderEntry[] {
    let childOrderChanged = false
    const withPinnedChildren = order.map((entry) => {
        if (typeof entry === 'string') return entry
        const data = stableFavoritePartition(entry.data, (id) => favoriteIds.has(id))
        if (sameEntries(data, entry.data)) return entry
        childOrderChanged = true
        return { ...entry, data }
    })
    const next = stableFavoritePartition(withPinnedChildren, (entry) => entryIsFavorite(entry, favoriteIds))
    if (!childOrderChanged && sameEntries(next, order)) return order
    return next
}

function moveToPartitionStart<T>(
    values: T[],
    fromIndex: number,
    favorite: boolean,
    isFavorite: (value: T) => boolean,
): T[] {
    const desiredIndex = favorite
        ? 0
        : values.reduce((count, value, index) => count + (index !== fromIndex && isFavorite(value) ? 1 : 0), 0)
    if (fromIndex === desiredIndex) return values
    const next = values.slice()
    const [value] = next.splice(fromIndex, 1)
    next.splice(desiredIndex, 0, value)
    return next
}

/**
 * Promotes a visited character without flattening the user's folder layout.
 * Favorites own the top section; regular recency changes happen directly
 * below it. The original array and folder objects are never mutated.
 */
export function promoteRecentlyViewedCharacter(
    order: CharacterOrderEntry[],
    characterId: string,
    favoriteIds: CharacterFavoriteIds = new Set(),
): CharacterOrderEntry[] {
    if (!characterId) return order

    const normalized = normalizeCharacterFavoriteOrder(order, favoriteIds)
    for (let orderIndex = 0; orderIndex < normalized.length; orderIndex++) {
        const entry = normalized[orderIndex]

        if (typeof entry === 'string') {
            if (entry !== characterId) continue
            const next = moveToPartitionStart(
                normalized,
                orderIndex,
                favoriteIds.has(characterId),
                (candidate) => entryIsFavorite(candidate, favoriteIds),
            )
            return next === normalized ? order : next
        }

        const characterIndex = entry.data.indexOf(characterId)
        if (characterIndex === -1) continue

        const nextData = moveToPartitionStart(
            entry.data,
            characterIndex,
            favoriteIds.has(characterId),
            (id) => favoriteIds.has(id),
        )
        const nextFolder = nextData === entry.data ? entry : { ...entry, data: nextData }
        const withUpdatedFolder = nextFolder === entry
            ? normalized
            : normalized.map((candidate, index) => index === orderIndex ? nextFolder : candidate)
        const currentFolderIndex = withUpdatedFolder.findIndex((candidate) => (
            typeof candidate !== 'string' && candidate.id === entry.id
        ))
        const next = moveToPartitionStart(
            withUpdatedFolder,
            currentFolderIndex,
            entryIsFavorite(nextFolder, favoriteIds),
            (candidate) => entryIsFavorite(candidate, favoriteIds),
        )
        return next === normalized && normalized === order ? order : next
    }

    return normalized
}

/** Moves a folder to the start of its current favorite/regular section. */
export function promoteCharacterFolder(
    order: CharacterOrderEntry[],
    folderId: string,
    favoriteIds: CharacterFavoriteIds = new Set(),
): CharacterOrderEntry[] {
    const normalized = normalizeCharacterFavoriteOrder(order, favoriteIds)
    const folderIndex = normalized.findIndex((entry) => typeof entry !== 'string' && entry.id === folderId)
    if (folderIndex === -1) return normalized
    const entry = normalized[folderIndex]
    const next = moveToPartitionStart(
        normalized,
        folderIndex,
        entryIsFavorite(entry, favoriteIds),
        (candidate) => entryIsFavorite(candidate, favoriteIds),
    )
    return next === normalized && normalized === order ? order : next
}

/**
 * Commits recency when a character is left, not when it is entered. Reopening
 * the current character is therefore a no-op; leaving for home uses no next id.
 */
export function promoteDepartedCharacter(
    order: CharacterOrderEntry[],
    departedCharacterId: string | undefined,
    nextCharacterId?: string,
    favoriteIds: CharacterFavoriteIds = new Set(),
): CharacterOrderEntry[] {
    if (!departedCharacterId || departedCharacterId === nextCharacterId) return order
    return promoteRecentlyViewedCharacter(order, departedCharacterId, favoriteIds)
}

/**
 * Places a newly imported character at the start of the regular catalog while
 * preserving the favorite section. Existing entries retain folder semantics.
 */
export function promoteNewlyImportedCharacter(
    order: CharacterOrderEntry[],
    characterId: string,
    favoriteIds: CharacterFavoriteIds = new Set(),
): CharacterOrderEntry[] {
    if (!characterId || characterId === '§temp' || characterId === '§playground') return order

    const exists = order.some((entry) => (
        typeof entry === 'string'
            ? entry === characterId
            : entry.data.includes(characterId)
    ))
    if (exists) return promoteRecentlyViewedCharacter(order, characterId, favoriteIds)

    const normalized = normalizeCharacterFavoriteOrder(order, favoriteIds)
    const insertAt = favoriteIds.has(characterId)
        ? 0
        : normalized.findIndex((entry) => !entryIsFavorite(entry, favoriteIds))
    const next = normalized.slice()
    next.splice(insertAt === -1 ? next.length : insertAt, 0, characterId)
    return next
}
