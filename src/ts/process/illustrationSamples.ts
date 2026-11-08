// Style samples (the user's request, 2026-11-09): each "프리셋 X" drawn once
// from the same scene, kept as an asset of the 🎨 module ("🎨 샘플 · X",
// illustrationAlbum.ts) — the album shows and deletes them, and so does the
// module's 에셋 tab. A module's assets are inline until the server moves them
// into a manifest (assetManifestMigration.cjs); both are read and written.
import { get, writable } from 'svelte/store'
import type { character } from '../storage/database.svelte'
import type { RisuModule } from './modules'
import { editAssetManifest, loadAssetManifestItems, saveAsset } from '../globalApi.svelte'
import { generateAIImage } from './stableDiff'
import { composeImagePrompt, ratioSize, type IllustrationPreset } from './illustration'
import { sampleAssetName, samplesByPreset, sampleScene } from './illustrationAlbum'
import { illustrationModuleOf } from './illustrationModule'
import { writableIllustrationModule } from './illustrationRun'
import { DBState } from '../stores.svelte'

type AssetTuple = [string, string, string]

/** A module's assets, inline or from its manifest. */
export async function moduleAssetList(module: RisuModule | undefined): Promise<AssetTuple[]> {
    if (!module) return []
    if (module.assetManifest) return await loadAssetManifestItems(module.assetManifest) as AssetTuple[]
    return Array.isArray(module.assets) ? module.assets : []
}

/** The 🎨 module's samples now, by preset name. */
export async function loadPresetSamples(): Promise<Map<string, { path: string, ext: string, index: number }>> {
    return samplesByPreset(await moduleAssetList(illustrationModuleOf(DBState.db)))
}

/** Put `item` in place of the asset named like it, or after the last one. */
async function putModuleAsset(module: RisuModule, item: AssetTuple): Promise<void> {
    const assets = await moduleAssetList(module)
    const index = assets.findIndex((asset) => asset?.[0] === item[0])
    if (module.assetManifest) {
        module.assetManifest = await editAssetManifest(module.assetManifest, [index >= 0 ? { type: 'replace', index, item } : { type: 'append', item }])
        return
    }
    module.assets = index >= 0 ? assets.map((asset, i) => (i === index ? item : asset)) : [...assets, item]
}

/** Take out the asset with this name; whether there was one. */
async function removeModuleAsset(module: RisuModule, name: string): Promise<boolean> {
    const assets = await moduleAssetList(module)
    const index = assets.findIndex((asset) => asset?.[0] === name)
    if (index < 0) return false
    if (module.assetManifest) {
        module.assetManifest = await editAssetManifest(module.assetManifest, [{ type: 'remove', index }])
        return true
    }
    module.assets = assets.filter((_, i) => i !== index)
    return true
}

/** The presets whose sample is being drawn, by name. */
export const drawingSamples = writable<ReadonlySet<string>>(new Set())

function setDrawing(name: string, on: boolean) {
    drawingSamples.update((current) => {
        const next = new Set(current)
        if (on) next.add(name)
        else next.delete(name)
        return next
    })
}

async function dataUrlBytes(url: string): Promise<Uint8Array> {
    return new Uint8Array(await (await fetch(url)).arrayBuffer())
}

/**
 * Draw a preset's sample (portrait, so every sample compares) and keep it in
 * the 🎨 module, over the one before. `character`: the bot the drawing is
 * asked from (NovelAI does not use it). Whether one was kept.
 */
export async function drawPresetSample(preset: IllustrationPreset, character: character, scene: string | undefined): Promise<boolean> {
    if (get(drawingSamples).has(preset.name)) return false
    setDrawing(preset.name, true)
    try {
        const prompt = composeImagePrompt(preset, sampleScene(scene))
        const image = await generateAIImage(prompt.positive, character, prompt.negative, 'inlay', {
            ...ratioSize('portrait'), characters: [], ...(prompt.nai ? { nai: prompt.nai } : {}),
        })
        if (!image) return false
        const ext = /^data:image\/jpe?g/i.test(image) ? 'jpg' : /^data:image\/webp/i.test(image) ? 'webp' : 'png'
        const path = await saveAsset(await dataUrlBytes(image), '', `sample.${ext}`)
        await putModuleAsset(writableIllustrationModule(), [sampleAssetName(preset.name), path, ext])
        return true
    } finally {
        setDrawing(preset.name, false)
    }
}

/** Delete a preset's sample from the 🎨 module. */
export async function removePresetSample(presetName: string): Promise<boolean> {
    const module = illustrationModuleOf(DBState.db)
    return module ? await removeModuleAsset(module, sampleAssetName(presetName)) : false
}
