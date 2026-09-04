type CharacterAssetCountSource = {
    sourceInfo?: {
        assetReferenceCount?: number
    }
    additionalAssetManifest?: {
        count?: number
    }
    additionalAssets?: unknown[]
}

function normalizeAssetCount(value: unknown): number | undefined {
    const count = Number(value)
    if (!Number.isFinite(count) || count < 0) return undefined
    return Math.floor(count)
}

/**
 * Returns the cheap, already-recorded asset count used by character lists.
 * Never enumerate or hydrate an asset manifest while rendering the catalog.
 */
export function getCharacterAssetCount(character: CharacterAssetCountSource): number {
    return normalizeAssetCount(character.sourceInfo?.assetReferenceCount)
        ?? normalizeAssetCount(character.additionalAssetManifest?.count)
        ?? character.additionalAssets?.length
        ?? 0
}
