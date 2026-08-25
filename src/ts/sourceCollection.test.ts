import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    SOURCE_COLLECTION_FORMAT,
    collectSourceCollectionAssetPaths,
    decodeAndVerifyCollectionAsset,
    parseSourceCollectionPart,
    rewriteSourceCollectionAssets,
    sha256Hex,
    sourceCollectionHeader,
    SOURCE_COLLECTION_MAX_ASSET_BYTES,
    validateSourceCollectionAssetCoverage,
    validateSourceCollectionHeaders,
} from './sourceCollection'

afterEach(() => {
    vi.unstubAllGlobals()
})

function part(index: number, last: boolean) {
    return parseSourceCollectionPart({
        format: SOURCE_COLLECTION_FORMAT,
        version: 1,
        bundleId: 'bundle-12345678',
        kind: 'characters',
        sourceLabel: '모바일웹리스',
        createdAt: 123,
        partIndex: index,
        last,
        entities: [],
        assets: [],
    })
}

describe('source collection validation', () => {
    it('sorts a complete bundle and rejects a missing part', () => {
        expect(validateSourceCollectionHeaders([sourceCollectionHeader(part(1, true)), sourceCollectionHeader(part(0, false))]))
            .toHaveLength(2)
        expect(() => validateSourceCollectionHeaders([sourceCollectionHeader(part(1, true))])).toThrow(/missing or duplicated/)
    })

    it('rejects path traversal and malformed hashes', () => {
        expect(() => parseSourceCollectionPart({
            ...part(0, true),
            assets: [{ path: 'assets/../secret', data: '', size: 0, sha256: 'x' }],
        })).toThrow(/asset path|asset hash/)
        expect(() => parseSourceCollectionPart({
            ...part(0, true),
            assets: [{ path: 'assets/..', data: '', size: 0, sha256: '0'.repeat(64) }],
        })).toThrow(/asset path/)
    })

    it('rejects hostile labels, oversized assets, and base64 length lies before decoding', () => {
        expect(() => parseSourceCollectionPart({ ...part(0, true), sourceLabel: 'mobile\nspoof' }))
            .toThrow(/source label/)
        expect(() => parseSourceCollectionPart({
            ...part(0, true),
            assets: [{
                path: 'assets/a.bin',
                data: '',
                size: SOURCE_COLLECTION_MAX_ASSET_BYTES + 1,
                sha256: '0'.repeat(64),
            }],
        })).toThrow(/asset size/)
        expect(() => parseSourceCollectionPart({
            ...part(0, true),
            assets: [{ path: 'assets/a.bin', data: 'A'.repeat(4096), size: 1, sha256: '0'.repeat(64) }],
        })).toThrow(/asset base64/)
    })

    it('rejects cyclic or excessively deep entity payloads', () => {
        const cyclic: Record<string, unknown> = { name: 'cycle' }
        cyclic.self = cyclic
        expect(() => parseSourceCollectionPart({ ...part(0, true), entities: [cyclic] }))
            .toThrow(/cycle or shared object/)

        let deep: Record<string, unknown> = { name: 'bottom' }
        for (let index = 0; index < 70; index++) deep = { name: 'level', child: deep }
        expect(() => parseSourceCollectionPart({ ...part(0, true), entities: [deep] }))
            .toThrow(/nested too deeply/)
    })

    it('accepts persona collection parts', () => {
        expect(parseSourceCollectionPart({
            ...part(0, true),
            kind: 'personas',
        }).kind).toBe('personas')
    })

    it('keeps v1 files compatible while validating optional relationship and omission metadata', () => {
        expect(part(0, true).collectionId).toBeUndefined()
        const parsed = parseSourceCollectionPart({
            ...part(0, true),
            collectionId: 'collection-12345678',
            entities: [{ name: 'large icon', icon: 'assets/large.png' }],
            omittedAssets: [{ path: 'assets/large.png', size: SOURCE_COLLECTION_MAX_ASSET_BYTES + 1, reason: 'too-large' }],
        })
        expect(parsed.collectionId).toBe('collection-12345678')
        expect(parsed.omittedAssets).toEqual([
            { path: 'assets/large.png', size: SOURCE_COLLECTION_MAX_ASSET_BYTES + 1, reason: 'too-large' },
        ])
        expect(() => parseSourceCollectionPart({
            ...parsed,
            assets: [{ path: 'assets/large.png', data: '', size: 0, sha256: '0'.repeat(64) }],
        })).toThrow(/both supplied and omitted/)
    })
})

describe('source collection references', () => {
    it('collects exact and embedded flat asset paths without false prefixes', () => {
        expect(collectSourceCollectionAssetPaths({
            image: 'assets/a.png',
            css: 'x{background:url(assets/b.webp)}',
            falsePositive: 'notassets/c.png',
            remote: 'https://example.com/assets/remote.png',
            nested: 'assets/folder/d.png',
            macro: '{{image::assets/macro.png}}',
        })).toEqual(['assets/a.png', 'assets/b.webp', 'assets/macro.png'])
    })

    it('requires exact referenced-asset coverage', () => {
        expect(() => validateSourceCollectionAssetCoverage(
            { icon: 'assets/a.png' },
            ['assets/a.png'],
        )).not.toThrow()
        expect(() => validateSourceCollectionAssetCoverage(
            { icon: 'assets/a.png' },
            [],
        )).toThrow(/missing/)
        expect(() => validateSourceCollectionAssetCoverage(
            { icon: 'assets/a.png' },
            ['assets/a.png', 'assets/extra.png'],
        )).toThrow(/Unreferenced/)
    })

    it('rewrites exact tuples and embedded CSS without mutating the source', () => {
        const source = { image: 'assets/a.png', assets: [['hero', 'assets/a.png']], css: 'url(assets/b.webp)' }
        const rewritten = rewriteSourceCollectionAssets(source, new Map([
            ['assets/a.png', 'assets/new-a.png'],
            ['assets/b.webp', 'assets/new-b.webp'],
        ]))
        expect(rewritten).toEqual({
            image: 'assets/new-a.png',
            assets: [['hero', 'assets/new-a.png']],
            css: 'url(assets/new-b.webp)',
        })
        expect(source.image).toBe('assets/a.png')
    })

    it('can deliberately clear an omitted asset reference', () => {
        expect(rewriteSourceCollectionAssets(
            { image: 'assets/missing.png', css: 'url(assets/missing.png)' },
            new Map([['assets/missing.png', '']]),
        )).toEqual({ image: '', css: 'url()' })
    })

    it('keeps __proto__ as inert data while rewriting untrusted JSON', () => {
        const source = JSON.parse('{"name":"safe","__proto__":{"polluted":true}}')
        const rewritten = rewriteSourceCollectionAssets(source, new Map()) as Record<string, unknown>
        expect(Object.hasOwn(rewritten, '__proto__')).toBe(true)
        expect((rewritten.__proto__ as Record<string, unknown>).polluted).toBe(true)
        expect((Object.prototype as any).polluted).toBeUndefined()
    })
})

describe('source collection asset integrity', () => {
    it('checks decoded size and sha256', async () => {
        const bytes = new TextEncoder().encode('asset')
        const sha256 = await sha256Hex(bytes)
        const data = btoa('asset')
        await expect(decodeAndVerifyCollectionAsset({ path: 'assets/a.bin', data, size: 5, sha256 }))
            .resolves.toEqual(bytes)
        await expect(decodeAndVerifyCollectionAsset({ path: 'assets/a.bin', data, size: 4, sha256 }))
            .rejects.toThrow(/size mismatch/)
    })

    it('verifies SHA-256 when an insecure LAN WebView exposes no SubtleCrypto', async () => {
        vi.stubGlobal('crypto', {})
        const bytes = new TextEncoder().encode('asset')
        await expect(sha256Hex(bytes)).resolves.toBe(
            'd59386e0ae435e292fbe0ebcdb954b75ed5fb3922091277cb19f798fc5d50718',
        )
        await expect(decodeAndVerifyCollectionAsset({
            path: 'assets/a.bin',
            data: btoa('asset'),
            size: 5,
            sha256: 'd59386e0ae435e292fbe0ebcdb954b75ed5fb3922091277cb19f798fc5d50718',
        })).resolves.toEqual(bytes)
    })
})
