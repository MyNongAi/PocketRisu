import type { character } from './storage/database.svelte'

export const AUTO_DEACTIVATE_DAY_MS = 24 * 60 * 60 * 1000

export function normalizeAutoDeactivateDays(value: unknown): number {
    const days = Math.floor(Number(value))
    if (!Number.isFinite(days) || days <= 0) return 0
    return Math.min(3650, days)
}

/**
 * Oldest first. A missing lastInteraction is deliberately ineligible: an old
 * card downloaded today can carry an ancient creation_date, which is not proof
 * that the local copy has been sitting unused.
 */
export function autoDeactivationCandidateIds(
    characters: readonly character[],
    days: number,
    now: number,
    excludedIds: ReadonlySet<string> = new Set(),
): string[] {
    const normalizedDays = normalizeAutoDeactivateDays(days)
    if (normalizedDays === 0) return []
    const cutoff = now - (normalizedDays * AUTO_DEACTIVATE_DAY_MS)

    return characters
        .filter((character) => {
            if (!character?.chaId || character.chaId === '§temp' || character.chaId === '§playground') return false
            if (character.favorite || character.trashTime || excludedIds.has(character.chaId)) return false
            const lastInteraction = Number(character.lastInteraction)
            return Number.isFinite(lastInteraction) && lastInteraction > 0 && lastInteraction < cutoff
        })
        .sort((left, right) => Number(left.lastInteraction) - Number(right.lastInteraction))
        .map((character) => character.chaId)
}
