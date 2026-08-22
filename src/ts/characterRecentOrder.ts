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
