export interface DuplicateNameGroup<T> {
    key: string
    label: string
    members: T[]
}

/** Normalize only visual separators/case; version numbers remain significant. */
export function normalizeDuplicateName(value: unknown): string {
    if (typeof value !== 'string') return ''
    return value
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\p{P}\p{S}\s_]+/gu, '')
}

// Shorter names only match when equal (duplicateNameSimilarity).
const SHORT_NAME_LENGTH = 5

/** The edit distance of `a` and `b`, or `limit + 1` once it is surely above `limit`. */
function editDistanceWithin(a: string, b: string, limit: number): number {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
    for (let row = 1; row <= a.length; row++) {
        const current = [row]
        let best = row
        for (let column = 1; column <= b.length; column++) {
            const value = Math.min(
                current[column - 1] + 1,
                previous[column] + 1,
                previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
            )
            current[column] = value
            if (value < best) best = value
        }
        if (best > limit) return limit + 1
        previous = current
    }
    return previous[b.length]
}

export function duplicateNameSimilarity(left: unknown, right: unknown): number {
    const a = normalizeDuplicateName(left)
    const b = normalizeDuplicateName(right)
    if (!a || !b) return 0
    if (a === b) return 1

    const longest = Math.max(a.length, b.length)
    // Short names produce dangerous false positives (e.g. two unrelated
    // two-letter Korean names), so only exact normalized matches qualify.
    if (longest < SHORT_NAME_LENGTH || Math.abs(a.length - b.length) / longest > 0.1) return 0

    let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
    for (let row = 1; row <= a.length; row++) {
        const current = [row]
        for (let column = 1; column <= b.length; column++) {
            current[column] = Math.min(
                current[column - 1] + 1,
                previous[column] + 1,
                previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
            )
        }
        previous = current
    }
    return 1 - previous[b.length] / longest
}

/**
 * Returns review-only groups. Nothing is merged or deleted; callers may place
 * the returned members in a visible candidate folder for manual inspection.
 */
export function findHighSimilarityNameGroups<T extends { name?: unknown }>(
    items: readonly T[],
    threshold = 0.9,
): DuplicateNameGroup<T>[] {
    const valid = items
        .map((item, sourceIndex) => ({ item, sourceIndex, normalized: normalizeDuplicateName(item.name) }))
        .filter((entry) => entry.normalized)
    const parent = valid.map((_, index) => index)

    const find = (index: number): number => {
        while (parent[index] !== index) {
            parent[index] = parent[parent[index]]
            index = parent[index]
        }
        return index
    }
    const union = (left: number, right: number) => {
        const leftRoot = find(left)
        const rightRoot = find(right)
        if (leftRoot === rightRoot) return
        // Preserve the oldest database item as the stable representative.
        if (valid[leftRoot].sourceIndex <= valid[rightRoot].sourceIndex) parent[rightRoot] = leftRoot
        else parent[leftRoot] = rightRoot
    }

    // Equal names join through a map instead of a pass over every pair, and
    // only distinct names of near lengths are compared, with an edit distance
    // that stops once it is past the threshold. The bot catalogs compute this
    // as they render, for 1,000+ bots (the user's request, 2026-10-26); the
    // groups are the same as comparing every pair.
    const firstWithName = new Map<string, number>()
    const distinct: number[] = []
    valid.forEach((entry, index) => {
        const first = firstWithName.get(entry.normalized)
        if (first === undefined) {
            firstWithName.set(entry.normalized, index)
            distinct.push(index)
        } else {
            union(first, index)
        }
    })
    // A name can be one edit off only from 1 / (1 - threshold) characters (10
    // at 0.9), and its partner is at most a tenth shorter: shorter names only
    // ever match when equal, which the map above did.
    const fuzzyFrom = Math.max(SHORT_NAME_LENGTH, Math.ceil(Math.ceil(1 / (1 - threshold) - 1e-9) * 0.9 - 1e-9))
    const byLength = distinct
        .filter((index) => valid[index].normalized.length >= fuzzyFrom)
        .sort((left, right) => valid[left].normalized.length - valid[right].normalized.length)
    for (let i = 0; i < byLength.length; i++) {
        const shorter = valid[byLength[i]].normalized
        for (let j = i + 1; j < byLength.length; j++) {
            const longer = valid[byLength[j]].normalized
            if ((longer.length - shorter.length) / longer.length > 0.1) break
            // The most edits the threshold allows (none below 10 characters at 0.9).
            const limit = Math.floor((1 - threshold) * longer.length + 1e-9)
            if (limit < 1) continue
            const distance = editDistanceWithin(shorter, longer, limit)
            if (distance <= limit && 1 - distance / longer.length >= threshold) union(byLength[i], byLength[j])
        }
    }

    const grouped = new Map<number, typeof valid>()
    for (let index = 0; index < valid.length; index++) {
        const root = find(index)
        const members = grouped.get(root) ?? []
        members.push(valid[index])
        grouped.set(root, members)
    }

    return [...grouped.values()]
        .filter((group) => group.length > 1)
        .map((group) => {
            group.sort((left, right) => left.sourceIndex - right.sourceIndex)
            return {
                key: group[0].normalized,
                label: typeof group[0].item.name === 'string' ? group[0].item.name.trim() : group[0].normalized,
                members: group.map((entry) => entry.item),
            }
        })
}
