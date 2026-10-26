import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NAI_MODELS, NAI_NOISE_SCHEDULES, naiSamplers, naiSwitches } from './naiOptions'

// The 🎨 panel offers what Settings › Other bots › Image generation offers.
const page = readFileSync(resolve(process.cwd(), 'src/lib/Setting/Pages/OtherBotSettings.svelte'), 'utf8')

function selectValues(bound: string): string[][] {
    const lists: string[][] = []
    const pattern = new RegExp(`<SelectInput[^>]*bind:value=\\{${bound.replace(/\./g, '\\.')}\\}[^>]*>([\\s\\S]*?)</SelectInput>`, 'g')
    for (const match of page.matchAll(pattern)) {
        lists.push([...match[1].matchAll(/<OptionInput value="([^"]+)"/g)].map((m) => m[1]))
    }
    return lists
}

describe('the NovelAI choices of the 🎨 panel', () => {
    it('are the settings page\'s models, samplers and noise schedules', () => {
        expect(selectValues('DBState.db.NAIImgModel')).toEqual([[...NAI_MODELS]])
        const samplers = selectValues('DBState.db.NAIImgConfig.sampler')
        expect(samplers).toEqual([
            naiSamplers('nai-diffusion-4-5-full').map((s) => s.value),
            naiSamplers('nai-diffusion-3').map((s) => s.value),
        ])
        expect(selectValues('DBState.db.NAIImgConfig.noise_schedule')).toEqual([[...NAI_NOISE_SCHEDULES]])
    })

    it('show the switches the settings page shows for the model and sampler', () => {
        expect(naiSwitches('nai-diffusion-3', 'k_euler')).toEqual({ smea: true, dyn: true, variety: true, decrisp: true, legacyUc: false })
        expect(naiSwitches('nai-diffusion-3', 'ddim_v3')).toMatchObject({ smea: false, dyn: false })
        expect(naiSwitches('nai-diffusion-4-full', 'k_euler')).toEqual({ smea: false, dyn: false, variety: true, decrisp: false, legacyUc: true })
        expect(naiSwitches('nai-diffusion-5-full', 'k_euler')).toEqual({ smea: false, dyn: false, variety: false, decrisp: false, legacyUc: false })
    })
})
