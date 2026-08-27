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

export function duplicateNameSimilarity(left: unknown, right: unknown): number {
    const a = normalizeDuplicateName(left)
    const b = normalizeDuplicateName(right)
    if (!a || !b) return 0
    if (a === b) return 1

    const longest = Math.max(a.length, b.length)
    // Short names produce dangerous false positives (e.g. two unrelated
    // two-letter Korean names), so only exact normalized matches qualify.
    if (longest < 5 || Math.abs(a.length - b.length) / longest > 0.1) return 0

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

    for (let left = 0; left < valid.length; left++) {
        for (let right = left + 1; right < valid.length; right++) {
            const longest = Math.max(valid[left].normalized.length, valid[right].normalized.length)
            if (Math.abs(valid[left].normalized.length - valid[right].normalized.length) / longest > 0.1) continue
            if (duplicateNameSimilarity(valid[left].normalized, valid[right].normalized) >= threshold) {
                union(left, right)
            }
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
