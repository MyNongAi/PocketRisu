export const EXTERNAL_ASSET_PREFIX = 'external://'

export interface ExternalAssetLocation {
    providerId: string
    assetHash: string
    uri: string
}

const providerIdPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
const sha256Pattern = /^[a-f0-9]{64}$/

export function parseExternalAssetLocation(value: unknown): ExternalAssetLocation | null {
    if (typeof value !== 'string' || !value.startsWith(EXTERNAL_ASSET_PREFIX)) return null
    const remainder = value.slice(EXTERNAL_ASSET_PREFIX.length)
    const slash = remainder.indexOf('/')
    if (slash <= 0) return null

    const providerId = remainder.slice(0, slash)
    const assetHash = remainder.slice(slash + 1).toLowerCase()
    if (!providerIdPattern.test(providerId) || providerId.includes('..') || !sha256Pattern.test(assetHash)) return null

    const uri = `${EXTERNAL_ASSET_PREFIX}${providerId}/${assetHash}`
    return { providerId, assetHash, uri }
}

export function isExternalAssetLocation(value: unknown): value is string {
    return parseExternalAssetLocation(value) !== null
}

export function getExternalAssetContentUrl(value: string): string {
    const parsed = parseExternalAssetLocation(value)
    if (!parsed) throw new Error(`Invalid external asset URI: ${value}`)
    return `/api/external-assets/content/${Buffer.from(parsed.uri, 'utf-8').toString('hex')}`
}
