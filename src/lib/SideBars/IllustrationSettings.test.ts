// @vitest-environment happy-dom

// The NovelAI box under the 🎨 settings folds (the user's request, 2026-10-28):
// it starts folded with a one-line summary and stays as it was left.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import { language } from 'src/lang'
import { DBState, selectedCharID } from 'src/ts/stores.svelte'
import { refreshModules } from 'src/ts/process/modules'
import IllustrationSettings from './IllustrationSettings.svelte'
import { useTogglesTestDb } from './togglesTestDb.svelte'

const mounted: Record<string, any>[] = []

beforeEach(() => {
    selectedCharID.set(0)
    useTogglesTestDb({
        sdProvider: 'novelai',
        NAIImgModel: 'nai-diffusion-4-5-full',
        NAIImgConfig: {
            width: 832, height: 1216, sampler: 'k_euler_ancestral', noise_schedule: 'karras',
            steps: 28, scale: 5, cfg_rescale: 0, sm: false, sm_dyn: false,
            variety_plus: false, decrisp: false, legacy_uc: false,
        },
    })
})

afterEach(() => {
    for (const component of mounted.splice(0).reverse()) unmount(component)
    document.body.replaceChildren()
    refreshModules()
})

async function settle() {
    flushSync()
    await tick()
    flushSync()
}

async function mountSettings() {
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(IllustrationSettings, { target }))
    await settle()
    const box = target.querySelector('[data-illustration-nai]') as HTMLElement
    return {
        box,
        trigger: box.querySelector('button[aria-expanded]') as HTMLButtonElement,
        region: box.querySelector('[role=region]') as HTMLElement,
        summary: () => box.querySelector('[data-illustration-nai-summary]')?.textContent ?? null,
    }
}

describe('the NovelAI box in the 🎨 settings', () => {
    it('starts folded, says what a drawing uses, and opens on a tap', async () => {
        const { trigger, region, summary } = await mountSettings()
        expect(trigger.getAttribute('aria-expanded')).toBe('false')
        expect(region.getAttribute('aria-hidden')).toBe('true')
        expect(summary()).toBe(`V4.5 full · ${language.illustrationNaiSteps} 28 · CFG 5`)

        DBState.db.NAIImgConfig.steps = 40
        await settle()
        expect(summary()).toContain(`${language.illustrationNaiSteps} 40`)

        trigger.click()
        await settle()
        expect(trigger.getAttribute('aria-expanded')).toBe('true')
        expect(region.getAttribute('aria-hidden')).toBe('false')
        expect(summary()).toBeNull()
    })

    it('stays as it was left when the sidebar opens it again', async () => {
        const first = await mountSettings()
        if (first.trigger.getAttribute('aria-expanded') === 'false') first.trigger.click()
        await settle()
        unmount(mounted.pop()!)

        const again = await mountSettings()
        expect(again.trigger.getAttribute('aria-expanded')).toBe('true')
        again.trigger.click()
        await settle()
        expect(again.trigger.getAttribute('aria-expanded')).toBe('false')
    })
})
