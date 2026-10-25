import { describe, expect, it } from 'vitest'
import { isStagingNonce, stagedAssetRef, withStagedAssets } from './stagedAssets'

const NONCE = '0123456789abcdef0123456789abcdef'
const OTHER = 'ffffffffffffffffffffffffffffffff'
const HASH = 'a'.repeat(64)
const bytes = (text: string) => new TextEncoder().encode(text)
const stub = (nonce: string, ref: string) => bytes(`PRSTAGE1:${nonce}:${ref}\n`)

describe('staged asset stubs', () => {
    it('name their stored object only while their import runs', async () => {
        const data = stub(NONCE, `external://main-assets/${HASH}`)
        expect(stagedAssetRef(data)).toBeUndefined()
        await withStagedAssets(NONCE, async () => {
            expect(stagedAssetRef(data)).toBe(`external://main-assets/${HASH}`)
            expect(stagedAssetRef(stub(NONCE, `assets/${HASH}.png`))).toBe(`assets/${HASH}.png`)
        })
        expect(stagedAssetRef(data)).toBeUndefined()
    })

    it('ignore another import\'s nonce and references saveAsset never returns', async () => {
        await withStagedAssets(NONCE, async () => {
            expect(stagedAssetRef(stub(OTHER, `assets/${HASH}.png`))).toBeUndefined()
            expect(stagedAssetRef(stub(NONCE, 'https://example.com/x.png'))).toBeUndefined()
            expect(stagedAssetRef(stub(NONCE, `assets/../${HASH}.png`))).toBeUndefined()
            expect(stagedAssetRef(bytes(`PRSTAGE1:${NONCE}:assets/${HASH}.png`))).toBeUndefined() // no end mark
        })
    })

    it('are found inside a PNG card\'s picture leftover, but not in large data', async () => {
        const inPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, ...stub(NONCE, `assets/${HASH}.png`), 0, 0, 0, 0])
        const large = new Uint8Array(4096)
        large.set(stub(NONCE, `assets/${HASH}.png`), 10)
        await withStagedAssets(NONCE, async () => {
            expect(stagedAssetRef(inPng)).toBe(`assets/${HASH}.png`)
            expect(stagedAssetRef(large)).toBeUndefined()
        })
    })

    it('stay accepted while any import with that nonce runs, and refuse a malformed nonce', async () => {
        const data = stub(NONCE, `assets/${HASH}.png`)
        let release!: () => void
        const first = withStagedAssets(NONCE, () => new Promise<void>((resolve) => { release = resolve }))
        await withStagedAssets(NONCE, async () => {})
        expect(stagedAssetRef(data)).toBe(`assets/${HASH}.png`)
        release()
        await first
        expect(stagedAssetRef(data)).toBeUndefined()
        expect(isStagingNonce('XYZ')).toBe(false)
        await expect(withStagedAssets('XYZ', async () => {})).rejects.toThrow()
    })
})
