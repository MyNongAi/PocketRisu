import { describe, expect, it } from 'vitest'
import { getCharacterAssetCount } from './characterAssetCount'

describe('getCharacterAssetCount', () => {
    it('prefers a recorded complete reference count', () => {
        expect(getCharacterAssetCount({
            sourceInfo: { assetReferenceCount: 42 },
            additionalAssetManifest: { count: 30 },
        })).toBe(42)
    })

    it('uses a lazy manifest count without hydrating its items', () => {
        expect(getCharacterAssetCount({ additionalAssetManifest: { count: 1234 } })).toBe(1234)
    })

    it('falls back to the inline additional asset length', () => {
        expect(getCharacterAssetCount({ additionalAssets: [1, 2, 3] })).toBe(3)
    })

    it('normalizes invalid counts', () => {
        expect(getCharacterAssetCount({ sourceInfo: { assetReferenceCount: -1 } })).toBe(0)
    })
})
