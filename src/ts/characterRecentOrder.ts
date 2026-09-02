import type { folder } from './storage/database.svelte'

export type CharacterOrderEntry = string | folder

/**
 * Promotes a visited character without flattening the user's folder layout.
 * Standalone characters move to the front. Characters inside a folder move
 * to the front of that folder, and their folder becomes the first top-level
 * entry. The original array and folder objects are never mutated.
 */
export function promoteRecentlyViewedCharacter(
    order: CharacterOrderEntry[],
    characterId: string,
): CharacterOrderEntry[] {
    if (!characterId) return order

    for (let orderIndex = 0; orderIndex < order.length; orderIndex++) {
        const entry = order[orderIndex]

        if (typeof entry === 'string') {
            if (entry !== characterId) continue
            if (orderIndex === 0) return order

            const next = order.slice()
            next.splice(orderIndex, 1)
            next.unshift(entry)
            return next
        }

        const characterIndex = entry.data.indexOf(characterId)
        if (characterIndex === -1) continue
        if (orderIndex === 0 && characterIndex === 0) return order

        const nextFolder: folder = {
            ...entry,
            data: entry.data.slice(),
        }
        if (characterIndex > 0) {
            nextFolder.data.splice(characterIndex, 1)
            nextFolder.data.unshift(characterId)
        }

        const next = order.slice()
        next.splice(orderIndex, 1)
        next.unshift(nextFolder)
        return next
    }

    return order
}

/**
 * Commits recency when a character is left, not when it is entered. Reopening
 * the current character is therefore a no-op; leaving for home uses no next id.
 */
export function promoteDepartedCharacter(
    order: CharacterOrderEntry[],
    departedCharacterId: string | undefined,
    nextCharacterId?: string,
): CharacterOrderEntry[] {
    if (!departedCharacterId || departedCharacterId === nextCharacterId) return order
    return promoteRecentlyViewedCharacter(order, departedCharacterId)
}

/**
 * Places a newly imported character at the start of the catalog. Unlike the
 * viewed-character helper, this intentionally inserts an ID that is not in
 * characterOrder yet. Existing entries still preserve folder semantics.
 */
export function promoteNewlyImportedCharacter(
    order: CharacterOrderEntry[],
    characterId: string,
): CharacterOrderEntry[] {
    if (!characterId || characterId === '§temp' || characterId === '§playground') return order

    const exists = order.some((entry) => (
        typeof entry === 'string'
            ? entry === characterId
            : entry.data.includes(characterId)
    ))
    if (exists) return promoteRecentlyViewedCharacter(order, characterId)

    return [characterId, ...order]
}
