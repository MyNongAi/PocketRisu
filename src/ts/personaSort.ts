// The persona order the persona tab and the chat sidebar's persona popup
// share: as registered, or the last applied first (the popup's toggle, the
// user's request of 2026-10-31). One saved choice serves both.

import { shownInside } from './folders'
import type { PromptPresetFolder } from './storage/database.svelte'

export type PersonaSortMode = 'registered' | 'recent'

const SORT_KEY = 'risu-persona-sort'

export function loadPersonaSort(): PersonaSortMode {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(SORT_KEY) === 'recent' ? 'recent' : 'registered'
    } catch {
        return 'registered'
    }
}

export function savePersonaSort(mode: PersonaSortMode) {
    try { localStorage.setItem(SORT_KEY, mode) } catch {}
}

/**
 * When a persona was last applied; one never applied since lastAppliedAt
 * arrived counts as the oldest. Most personas predate the field, and
 * Number(undefined) is NaN: a NaN difference made the "recently applied"
 * sort inconsistent, so the persona just picked did not come first.
 */
export function personaAppliedAt(persona: { lastAppliedAt?: number } | null | undefined): number {
    return Number(persona?.lastAppliedAt) || 0
}

/** Persona indexes, the last applied first; ties keep the list order. */
export function compareRecentlyApplied(personas: readonly ({ lastAppliedAt?: number } | null | undefined)[]) {
    return (left: number, right: number) => (personaAppliedAt(personas[right]) - personaAppliedAt(personas[left])) || left - right
}

type Group = { folder: PromptPresetFolder | null, indexes: number[] }

/**
 * Folder groups in `mode` order: each group's personas, and in 'recent' the
 * groups too, the one holding the last applied persona first. A folder is as
 * recent as the folders shown inside it.
 */
export function sortPersonaGroups<G extends Group>(
    groups: readonly G[],
    personas: readonly ({ lastAppliedAt?: number } | null | undefined)[],
    folders: readonly PromptPresetFolder[],
    mode: PersonaSortMode,
): G[] {
    const sorted = groups.map((group) => ({
        ...group,
        indexes: [...group.indexes].sort(mode === 'recent' ? compareRecentlyApplied(personas) : (left, right) => left - right),
    }))
    if (mode !== 'recent') return sorted
    const keyOf = (group: Group) => group.folder?.id ?? ''
    const latest = new Map(sorted.map((group) => [keyOf(group), Math.max(0, ...group.indexes.map((index) => personaAppliedAt(personas[index])))]))
    for (const group of sorted) {
        const parentId = shownInside(group.folder, folders)
        if (parentId && latest.has(parentId)) latest.set(parentId, Math.max(latest.get(parentId) ?? 0, latest.get(keyOf(group)) ?? 0))
    }
    return sorted.sort((left, right) => (latest.get(keyOf(right)) ?? 0) - (latest.get(keyOf(left)) ?? 0))
}
