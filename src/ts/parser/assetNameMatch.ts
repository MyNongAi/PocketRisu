// Keep this list and separator rule in sync with the manifest resolver.
export const ASSET_NAME_EXTENSIONS = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'mp4', 'webm', 'avi', 'm4p', 'm4v', 'mp3', 'wav', 'ogg']

export function trimAssetName(str: string): string {
    for (const ext of ASSET_NAME_EXTENSIONS) {
        if (str.endsWith('.' + ext)) str = str.slice(0, -ext.length - 1)
    }
    return str.trim().replace(/[_ -.]/g, '')
}

function assetStem(name: string): string {
    let stem = name.toLocaleLowerCase().trim()
    const first = stem[0]
    const last = stem[stem.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '“' && last === '”')) {
        stem = stem.slice(1, -1).trim()
    }
    for (const ext of ASSET_NAME_EXTENSIONS) {
        if (stem.endsWith('.' + ext)) return stem.slice(0, -ext.length - 1)
    }
    return stem
}

export function normalizedAssetKey(name: string): string {
    return assetStem(name).replace(/[_ -.]/g, '')
}

export function assetPrefix(name: string): string | null {
    const stem = assetStem(name)
    const separator = stem.search(/[._]/)
    return separator > 0 ? stem.slice(0, separator) : null
}

export type AssetNameIndex<T> = { normalized: Map<string, T>; prefixes: Set<string> }

export function addAssetName<T>(index: AssetNameIndex<T>, name: string, value: T): void {
    const key = normalizedAssetKey(name)
    if (!index.normalized.has(key)) index.normalized.set(key, value)
    const prefix = assetPrefix(name)
    if (prefix !== null) index.prefixes.add(prefix)
}

export function permitsFuzzyName(name: string, candidate: string, prefixes: ReadonlySet<string>): boolean {
    const prefix = assetPrefix(name)
    return prefix === null || !prefixes.has(prefix) || assetPrefix(candidate) === prefix
}

export function findAssetName<T>(
    name: string,
    exact: ReadonlyMap<string, T>,
    index: AssetNameIndex<T>,
    fuzzyCandidates: readonly { name: string; value: T }[],
    maxDifference: number,
    distance: (a: string, b: string) => number,
): T | undefined {
    const direct = exact.get(name.toLocaleLowerCase())
    if (direct !== undefined) return direct
    const normalized = index.normalized.get(normalizedAssetKey(name))
    if (normalized !== undefined) return normalized
    let bestDistance = Infinity
    let best: T | undefined
    const key = trimAssetName(name.toLocaleLowerCase())
    for (const candidate of fuzzyCandidates) {
        if (!permitsFuzzyName(name, candidate.name, index.prefixes)) continue
        const score = distance(key, trimAssetName(candidate.name.toLocaleLowerCase()))
        if (score < bestDistance) {
            bestDistance = score
            best = candidate.value
        }
    }
    return bestDistance <= maxDifference ? best : undefined
}
