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

    // The user's request (2026-10-28): with a preset picked, the fields change
    // that preset's NAI entry (the model too); without one, the settings.
    it('writes into the picked preset\'s NAI entry, and into the settings without one', async () => {
        const char = DBState.db.characters[0]
        char.globalLore = [
            { key: 'F', mode: 'folder', comment: '프리셋 수채화', content: '', insertorder: 100, alwaysActive: false, secondkey: '', selective: false },
            { key: '', folder: 'F', mode: 'normal', comment: 'Positive', content: '{prompt}, watercolor', insertorder: 100, alwaysActive: false, secondkey: '', selective: false },
            { key: '', folder: 'F', mode: 'normal', comment: 'NAI', content: '# hint\nsteps: 20', insertorder: 100, alwaysActive: false, secondkey: '', selective: false },
        ]
        char.nodeOnlyIllustration = { enabled: true, preset: '수채화' }
        const { box, trigger } = await mountSettings()
        if (trigger.getAttribute('aria-expanded') === 'false') trigger.click()
        await settle()

        expect(box.querySelector('[data-nai-saves-to]')?.textContent).toContain('수채화')
        const numbers = [...box.querySelectorAll('input[type=number]')] as HTMLInputElement[]
        expect(numbers[0].value).toBe('20')
        expect(numbers[1].value).toBe('5')
        numbers[1].value = '6.5'
        numbers[1].dispatchEvent(new Event('change', { bubbles: true }))
        const model = [...box.querySelectorAll('select')].find((s) => s.querySelector('option[value="nai-diffusion-3"]'))!
        model.value = 'nai-diffusion-3'
        model.dispatchEvent(new Event('change', { bubbles: true }))
        await settle()

        const nai = () => DBState.db.characters[0].globalLore.find((e) => e.comment === 'NAI')!.content
        expect(nai()).toBe('# hint\nsteps: 20\nscale: 6.5\nmodel: nai-diffusion-3')
        expect(DBState.db.NAIImgConfig.scale).toBe(5)
        expect(DBState.db.NAIImgModel).toBe('nai-diffusion-4-5-full')
        expect(box.querySelectorAll('[data-nai-from-preset]').length).toBe(3)

        // The API key is the settings' own, hidden like a password.
        const key = box.querySelector('input[type=password]') as HTMLInputElement
        expect(key).toBeTruthy()

        DBState.db.characters[0].nodeOnlyIllustration = { enabled: true }
        await settle()
        expect(box.querySelector('[data-nai-saves-to]')).toBeNull()
        const steps = box.querySelector('input[type=number]') as HTMLInputElement
        steps.value = '33'
        steps.dispatchEvent(new Event('change', { bubbles: true }))
        await settle()
        expect(DBState.db.NAIImgConfig.steps).toBe(33)
        expect(nai()).toBe('# hint\nsteps: 20\nscale: 6.5\nmodel: nai-diffusion-3')
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
