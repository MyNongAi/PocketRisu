import { describe, expect, it } from 'vitest'
import {
    getExternalAssetContentUrl,
    isExternalAssetLocation,
    parseExternalAssetLocation,
} from './externalAssets'

describe('external asset locations', () => {
    const hash = 'a'.repeat(64)
    const uri = `external://local_store/${hash}`

    it('parses a provider and SHA-256 key', () => {
        expect(parseExternalAssetLocation(uri)).toEqual({
            providerId: 'local_store',
            assetHash: hash,
            uri,
        })
        expect(isExternalAssetLocation(uri)).toBe(true)
    })

    it('rejects traversal, malformed providers, and ordinary paths', () => {
        expect(parseExternalAssetLocation('external://local/../../secret')).toBeNull()
        expect(parseExternalAssetLocation(`external://bad provider/${hash}`)).toBeNull()
        expect(parseExternalAssetLocation('assets/example.png')).toBeNull()
    })

    it('creates a URL without fetching the asset bytes', () => {
        expect(getExternalAssetContentUrl(uri)).toBe(
            `/api/external-assets/content/${Buffer.from(uri).toString('hex')}`,
        )
    })
})
