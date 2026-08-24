import { describe, expect, it, vi } from 'vitest'
import doctorPkg from './asset-doctor.cjs'
import externalPkg from './external-assets.cjs'
import workerPkg from './asset-doctor-reference-worker.cjs'

const { diagnoseAssetReferences, groupReferences, statWithBoundedRetry } = doctorPkg as any
const { makeExternalAssetUri, sha256 } = externalPkg as any
const { collectDoctorReferences } = workerPkg as any

describe('asset doctor reference grouping', () => {
    it('deduplicates payload checks while retaining occurrence and owner samples', () => {
        const grouped = groupReferences([
            { value: 'assets/a.png', ownerType: 'character', ownerId: 'a', field: 'image' },
            { value: 'assets/a.png', ownerType: 'persona', ownerId: 'p', field: 'icon' },
            { value: 'assets/b.png', ownerType: 'embedded' },
        ])

        expect(grouped).toHaveLength(2)
        expect(grouped[0]).toMatchObject({ reference: 'assets/a.png', kind: 'internal', occurrences: 2 })
        expect(grouped[0].owners).toEqual([
            { ownerType: 'character', ownerId: 'a', field: 'image', path: null },
            { ownerType: 'persona', ownerId: 'p', field: 'icon', path: null },
        ])
    })

    it('collects persona icons and embedded chat/macro refs in the worker snapshot', () => {
        const external = `external://remote/${'a'.repeat(64)}`
        const references = collectDoctorReferences({
            userIcon: 'assets/shared.png',
            personas: [{ id: 'p', icon: 'assets/shared.png' }],
            characters: [{
                chaId: 'c',
                image: 'assets/character.png',
                additionalAssets: [['external', external]],
                chats: [{ message: [{ data: `look {{image::assets/chat-only.webp}} ${external} external://remote/broken` }] }],
            }],
        })
        const shared = references.find((reference: any) => reference.value === 'assets/shared.png')
        expect(shared).toMatchObject({ occurrences: 2 })
        expect(shared.owners.map((owner: any) => owner.ownerType)).toEqual(['persona', 'persona'])
        expect(references).toContainEqual(expect.objectContaining({
            value: 'assets/chat-only.webp',
            occurrences: 1,
            owners: [expect.objectContaining({ ownerType: 'embedded', field: 'macro-or-text' })],
        }))
        expect(references).toContainEqual(expect.objectContaining({
            value: external,
            occurrences: 2,
            owners: expect.arrayContaining([
                expect.objectContaining({ ownerType: 'character', field: 'additionalAssets' }),
                expect.objectContaining({ ownerType: 'embedded', field: 'macro-or-text' }),
            ]),
        }))
        expect(references).toContainEqual(expect.objectContaining({
            value: 'external://remote/broken',
            occurrences: 1,
        }))
    })
})

describe('read-only asset diagnosis', () => {
    it('bounds retries for transient filesystem stat failures', async () => {
        const stat = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('busy'), { retryable: true }))
            .mockResolvedValue({ size: 10 })
        await expect(statWithBoundedRetry({ stat }, 'a'.repeat(64))).resolves.toEqual({ size: 10 })
        expect(stat).toHaveBeenCalledTimes(2)
    })

    it('stats every unique reference but reads only the bounded hash/decode sample', async () => {
        const firstData = Buffer.from('first image bytes')
        const secondData = Buffer.from('second image bytes')
        const firstUri = makeExternalAssetUri('remote', sha256(firstData))
        const secondUri = makeExternalAssetUri('remote', sha256(secondData))
        const provider = {
            id: 'remote',
            capabilities: { read: true, write: true, stat: true },
            stat: vi.fn(async (hash: string) => ({ size: hash === sha256(firstData) ? firstData.length : secondData.length })),
        }
        const readWithMeta = vi.fn(async (uri: string) => ({
            data: uri === firstUri ? firstData : secondData,
            source: 'external',
        }))
        const decodeImage = vi.fn(async () => undefined)

        const result = await diagnoseAssetReferences({
            references: [
                { value: 'assets/local.bin', ownerType: 'persona', ownerId: 'p1', field: 'icon' },
                { value: firstUri, ownerType: 'character', ownerId: 'c1', field: 'image' },
                { value: secondUri, ownerType: 'module', ownerId: 'm1', field: 'assets' },
            ],
            manifestEntries: [
                { uri: firstUri, size: firstData.length, mimeType: 'image/png' },
                { uri: secondUri, size: secondData.length, mimeType: 'image/png' },
            ],
            providers: [provider],
            service: { readWithMeta, cache: { get: () => undefined }, inspectFallbacks: async () => [] },
            statInternal: vi.fn(async () => ({ size: 4 })),
            readInternal: vi.fn(async () => Buffer.from('data')),
            decodeImage,
            sampleLimit: 1,
            concurrency: 1,
        })

        expect(provider.stat).toHaveBeenCalledTimes(2)
        expect(readWithMeta).toHaveBeenCalledTimes(1)
        expect(result.summary).toMatchObject({ uniqueAssets: 3, problems: 0, healthy: 3, hashVerifiedSamples: 1 })
        expect(result.samplePolicy.maxSamples).toBe(1)
    })

    it('distinguishes missing manifest, missing internal row, provider failure, and corrupt cache', async () => {
        const good = Buffer.from('good external bytes')
        const down = Buffer.from('down external bytes')
        const goodUri = makeExternalAssetUri('remote', sha256(good))
        const downUri = makeExternalAssetUri('remote', sha256(down))
        const noManifestUri = makeExternalAssetUri('remote', 'f'.repeat(64))
        const provider = {
            id: 'remote',
            capabilities: { read: true, write: true, stat: true },
            stat: vi.fn(async (hash: string) => {
                if (hash === sha256(down)) throw Object.assign(new Error('offline'), { code: 'OFFLINE' })
                return { size: good.length }
            }),
        }
        const inspectFallbacks = vi.fn(async (uri: string) => (
            uri === downUri ? [{ source: 'trash', available: true, size: down.length }] : []
        ))

        const result = await diagnoseAssetReferences({
            references: [
                { value: 'assets/missing.png', ownerType: 'persona', ownerId: 'p1', field: 'icon' },
                { value: goodUri, ownerType: 'character', ownerId: 'c1', field: 'image' },
                { value: downUri, ownerType: 'module', ownerId: 'm1', field: 'assets' },
                { value: noManifestUri, ownerType: 'character', ownerId: 'c2', field: 'image' },
                { value: 'external://remote/not-a-sha256', ownerType: 'persona', ownerId: 'p2', field: 'icon' },
            ],
            manifestEntries: [
                { uri: goodUri, size: good.length, mimeType: 'image/png' },
                { uri: downUri, size: down.length, mimeType: 'image/png', fallbacks: [{ trashPath: 'safe.bin' }] },
            ],
            providers: [provider],
            service: {
                cache: { get: (uri: string) => uri === goodUri ? Buffer.from('corrupt') : undefined },
                inspectFallbacks,
                readWithMeta: async () => ({ data: good, source: 'external' }),
            },
            statInternal: async () => null,
            readInternal: async () => null,
            sampleLimit: 0,
            concurrency: 1,
        })

        expect(result.issues.map((issue: any) => issue.code).sort()).toEqual([
            'cache-corrupt',
            'internal-missing',
            'invalid-external-reference',
            'manifest-missing',
            'provider-unavailable',
        ])
        expect(result.issues.find((issue: any) => issue.code === 'provider-unavailable')).toMatchObject({
            fallbackAvailable: true,
            fallbackSource: 'trash',
            repairable: true,
            repairAction: 'restore-exact-hash',
        })
        expect(result.issues.find((issue: any) => issue.code === 'internal-missing')).toMatchObject({
            repairable: false,
        })
        expect(result.summary).toMatchObject({ problems: 5, missing: 2, cacheProblems: 1, providerProblems: 1, invalidExternalAssets: 1 })
    })

    it('does not load an oversized image merely to test decoding', async () => {
        const data = Buffer.from('large placeholder')
        const uri = makeExternalAssetUri('remote', sha256(data))
        const readWithMeta = vi.fn()
        const result = await diagnoseAssetReferences({
            references: [{ value: uri, ownerType: 'character', ownerId: 'c', field: 'image' }],
            manifestEntries: [{ uri, size: 64 * 1024 * 1024, mimeType: 'image/png' }],
            providers: [{
                id: 'remote',
                capabilities: { read: true, write: true, stat: true },
                stat: async () => ({ size: 64 * 1024 * 1024 }),
            }],
            service: { readWithMeta, cache: { get: () => undefined }, inspectFallbacks: async () => [] },
            sampleLimit: 12,
            maxSampleBytes: 1024,
        })

        expect(readWithMeta).not.toHaveBeenCalled()
        expect(result.summary).toMatchObject({ healthy: 1, skippedLargeSamples: 1 })
    })

    it('keeps concurrent stat checks but serializes sampled payload reads and decode', async () => {
        const payloads = [Buffer.from('one'), Buffer.from('two'), Buffer.from('three')]
        const uris = payloads.map((data) => makeExternalAssetUri('remote', sha256(data)))
        let active = 0
        let maxActive = 0
        const readWithMeta = vi.fn(async (uri: string) => {
            active++
            maxActive = Math.max(maxActive, active)
            await new Promise((resolve) => setTimeout(resolve, 5))
            active--
            return { data: payloads[uris.indexOf(uri)], source: 'external' }
        })

        const result = await diagnoseAssetReferences({
            references: uris.map((value) => ({ value })),
            manifestEntries: uris.map((uri, index) => ({ uri, size: payloads[index].length, mimeType: 'image/png' })),
            providers: [{
                id: 'remote',
                capabilities: { read: true, write: true, stat: true },
                stat: async (hash: string) => ({ size: payloads.find((data) => sha256(data) === hash)?.length }),
            }],
            service: { readWithMeta, cache: { get: () => undefined }, inspectFallbacks: async () => [] },
            decodeImage: async () => undefined,
            sampleLimit: 3,
            concurrency: 4,
        })

        expect(result.summary.hashVerifiedSamples).toBe(3)
        expect(maxActive).toBe(1)
    })

    it('bounds retained issue records while preserving complete summary counts', async () => {
        const result = await diagnoseAssetReferences({
            references: Array.from({ length: 220 }, (_, index) => ({
                value: `external://remote/broken-${index}`,
            })),
            issueRecordLimit: 200,
            sampleLimit: 0,
        })

        expect(result.summary.problems).toBe(220)
        expect(result.issues).toHaveLength(200)
        expect(result.issuesOmitted).toBe(20)
    })

    it('verifies standard content-hash internal asset names without guessing arbitrary names', async () => {
        const expected = Buffer.from('expected internal bytes')
        const reference = `assets/${sha256(expected)}.png`
        const result = await diagnoseAssetReferences({
            references: [{ value: reference, ownerType: 'persona', ownerId: 'p', field: 'icon' }],
            statInternal: async () => ({ size: expected.length }),
            readInternal: async () => Buffer.from('corrupt internal bytes'),
            decodeImage: async () => undefined,
            manifestEntries: [],
            sampleLimit: 1,
        })

        expect(result.issues).toContainEqual(expect.objectContaining({
            code: 'hash-mismatch',
            kind: 'internal',
            expectedHash: sha256(expected),
            repairable: false,
        }))
        expect(result.summary).toMatchObject({ integrityProblems: 1, healthy: 0 })
    })
})
