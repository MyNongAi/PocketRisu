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

/**
 * New applied times that keep a drag in the recent sort where it was dropped
 * (the user's request, 2026-11-07: modules move by drag in 최근순, personas
 * did not). `shown`: the rows as the drop left them, top to bottom, each in
 * its folder. The list shows the folders in their own order, so only the
 * order inside each folder (and among the loose rows) is the recency. There
 * the longest run of rows already in order keeps its times and the rest get
 * times between their neighbors, so a drop changes the moved persona only.
 * Equal times (personas never applied are all 0) leave no room between them:
 * the run then takes in the tied rows above it. Returns persona index ->
 * new time, for the personas that change.
 */
export function appliedTimesAfterDrop(
    shown: readonly { index: number, folderId?: string }[],
    personas: readonly ({ lastAppliedAt?: number } | null | undefined)[],
): Map<number, number> {
    const before = compareRecentlyApplied(personas)
    const times = new Map<number, number>()
    const byFolder = new Map<string, number[]>()
    for (const row of shown) {
        const key = row.folderId ?? ''
        byFolder.set(key, [...(byFolder.get(key) ?? []), row.index])
    }
    for (const rows of byFolder.values()) {
        if (rows.every((index, i) => i === 0 || before(rows[i - 1], index) < 0)) continue
        // The longest chain of rows already in order (O(n²): one folder's personas).
        const length = rows.map(() => 1)
        const previous = rows.map(() => -1)
        for (let i = 0; i < rows.length; i++) {
            for (let j = 0; j < i; j++) {
                if (before(rows[j], rows[i]) < 0 && length[j] + 1 > length[i]) {
                    length[i] = length[j] + 1
                    previous[i] = j
                }
            }
        }
        const kept = new Set<number>()
        for (let i = length.indexOf(Math.max(...length)); i >= 0; i = previous[i]) kept.add(i)
        const timeAt = (i: number) => times.get(rows[i]) ?? personaAppliedAt(personas[rows[i]])
        let i = 0
        while (i < rows.length) {
            if (kept.has(i)) { i++; continue }
            let start = i
            let end = i
            while (end + 1 < rows.length && !kept.has(end + 1)) end++
            const below = end + 1 < rows.length ? timeAt(end + 1) : null
            // No room under a row of the same time: that row moves too.
            while (below !== null && start > 0 && timeAt(start - 1) <= below) {
                start--
                kept.delete(start)
            }
            const above = start > 0 ? timeAt(start - 1) : null
            const count = end - start + 1
            for (let k = 0; k < count; k++) {
                const time = above === null
                    ? (below ?? 0) + (count - k)
                    : below === null
                        ? above - (k + 1)
                        : below + (above - below) * (count - k) / (count + 1)
                times.set(rows[start + k], time)
            }
            i = end + 1
        }
    }
    return times
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
