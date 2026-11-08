import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ value: {} as any }))
const generateAIImage = vi.hoisted(() => vi.fn())
const saveAsset = vi.hoisted(() => vi.fn(async (_data: Uint8Array, _id?: string, _name?: string) => 'assets/s1.png'))
const editAssetManifest = vi.hoisted(() => vi.fn(async (manifest: any, _ops: any[]) => ({ ...manifest, id: `${manifest.id}+` })))
const loadAssetManifestItems = vi.hoisted(() => vi.fn(async (_manifest: any) => [] as any[]))

vi.mock('../stores.svelte', () => ({ DBState: { get db() { return db.value } } }))
vi.mock('../globalApi.svelte', () => ({ editAssetManifest, loadAssetManifestItems, saveAsset }))
vi.mock('./stableDiff', () => ({ generateAIImage }))
vi.mock('./illustrationRun', () => ({
    writableIllustrationModule: () => db.value.modules.find((m: any) => m.nodeOnlyIllustrationModule),
}))

const { drawPresetSample, loadPresetSamples, removePresetSample } = await import('./illustrationSamples')

const preset = { name: 'Water', positive: 'watercolor, {prompt}', negative: 'lowres', nai: { steps: 23 } }
const bot = { chaId: 'b1', name: 'Bot' } as any
const PNG = `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`

function artModule(extra: any = {}) {
    const module = { id: 'art', name: '🎨 삽화', nodeOnlyIllustrationModule: true, lorebook: [], ...extra }
    db.value = { modules: [{ id: 'other', name: 'x', assets: [['🎨 샘플 · Water', 'assets/no.png', 'png']] }, module] }
    return module
}

beforeEach(() => {
    generateAIImage.mockReset()
    saveAsset.mockClear()
    editAssetManifest.mockClear()
    loadAssetManifestItems.mockReset()
})

describe('style samples in the 🎨 module', () => {
    it('draws a preset from the sample scene, portrait, and keeps the picture as the module\'s asset', async () => {
        const module = artModule({ assets: [['smile', 'assets/smile.png', 'png']] })
        generateAIImage.mockResolvedValue(PNG)
        expect(await drawPresetSample(preset, bot, '1boy, running')).toBe(true)
        expect(generateAIImage).toHaveBeenCalledWith('watercolor, 1boy, running', bot, 'lowres', 'inlay', {
            width: 832, height: 1216, characters: [], nai: { steps: 23 },
        })
        expect([...saveAsset.mock.calls[0][0]]).toEqual([1, 2, 3])
        expect(saveAsset.mock.calls[0][2]).toBe('sample.png')
        expect(module.assets).toEqual([['smile', 'assets/smile.png', 'png'], ['🎨 샘플 · Water', 'assets/s1.png', 'png']])
        expect([...(await loadPresetSamples()).keys()]).toEqual(['Water'])

        // Drawn again: in the place of the one before.
        saveAsset.mockResolvedValueOnce('assets/s2.png')
        await drawPresetSample(preset, bot, '')
        expect(generateAIImage.mock.calls[1][0]).toContain('1girl, solo')
        expect(module.assets).toEqual([['smile', 'assets/smile.png', 'png'], ['🎨 샘플 · Water', 'assets/s2.png', 'png']])

        expect(await removePresetSample('Water')).toBe(true)
        expect(module.assets).toEqual([['smile', 'assets/smile.png', 'png']])
        expect(await removePresetSample('Water')).toBe(false)
    })

    it('edits the manifest when the server keeps the module\'s assets there', async () => {
        const module: any = artModule({ assetManifest: { id: 'm1', ownerKind: 'module', ownerId: 'art', count: 2 } })
        loadAssetManifestItems.mockResolvedValue([['smile', 'assets/smile.png', 'png'], ['🎨 샘플 · Water', 'assets/old.png', 'png']])
        generateAIImage.mockResolvedValue(PNG)
        await drawPresetSample(preset, bot, undefined)
        expect(editAssetManifest).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'm1' }), [
            { type: 'replace', index: 1, item: ['🎨 샘플 · Water', 'assets/s1.png', 'png'] },
        ])
        expect(module.assetManifest.id).toBe('m1+')
        expect(module.assets).toBeUndefined()

        loadAssetManifestItems.mockResolvedValue([['smile', 'assets/smile.png', 'png']])
        await drawPresetSample({ ...preset, name: 'Ink' }, bot, undefined)
        expect(editAssetManifest).toHaveBeenLastCalledWith(expect.anything(), [
            { type: 'append', item: ['🎨 샘플 · Ink', 'assets/s1.png', 'png'] },
        ])

        loadAssetManifestItems.mockResolvedValue([['smile', 'a', 'png'], ['🎨 샘플 · Ink', 'b', 'png']])
        expect(await removePresetSample('Ink')).toBe(true)
        expect(editAssetManifest).toHaveBeenLastCalledWith(expect.anything(), [{ type: 'remove', index: 1 }])
    })

    it('keeps nothing when the picture was not drawn', async () => {
        const module = artModule()
        generateAIImage.mockResolvedValue(false)
        expect(await drawPresetSample(preset, bot, undefined)).toBe(false)
        expect(saveAsset).not.toHaveBeenCalled()
        expect(module).not.toHaveProperty('assets')
    })
})
