// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'

const state = vi.hoisted(() => ({
    db: {
        customModels: [],
        modelPresets: [
            { id: 'p37', name: 'Vertex AI 5 · gemini-3.7-flash' },
            { id: 'p38', name: 'Vertex AI 5 · gemini-3.8-flash' },
        ],
    } as any,
}))

vi.mock('src/ts/stores.svelte', () => ({ DBState: { get db() { return state.db } } }))
vi.mock('src/ts/horde/getModels', () => ({ getHordeModels: async () => [] }))
vi.mock('src/ts/model/modellist', () => ({
    getModelList: () => [
        { providerName: 'Google', models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }] },
        { providerName: 'Plugins', models: [{ id: 'pluginmodel:::[PM] gemini-3.7-flash (Vertex AI 5)', name: '[PM] gemini-3.7-flash (Vertex AI 5)' }] },
    ],
    getModelInfo: (id: string) => {
        const preset = state.db.modelPresets.find((p: any) => `modelpreset:::${p.id}` === id)
        const name = preset?.name ?? id
        return { id, name, shortName: name, fullName: name }
    },
}))

import ModelList from './ModelList.svelte'

const mounted: unknown[] = []
afterEach(async () => {
    await Promise.all(mounted.splice(0).map((component) => unmount(component as never)))
    document.body.replaceChildren()
})

async function open(value: string, onChange = vi.fn()) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(ModelList, { target, props: { value, onChange } }))
    await tick()
    ;(target.querySelector('button') as HTMLButtonElement).click()
    flushSync()
    return { target, onChange }
}

const tabLabels = () => [...document.querySelectorAll('.rounded-md.border button')].map((button) => button.textContent?.trim())

describe('model picker', () => {
    it('shows built-in, plugin and model preset tabs side by side', async () => {
        await open('gemini-2.5-pro')
        expect(tabLabels()).toEqual(['Built-in', 'Plugin', 'Model presets'])
    })

    it('picking a preset stores it like any other model', async () => {
        const { onChange } = await open('pluginmodel:::[PM] gemini-3.7-flash (Vertex AI 5)')
        const presetTab = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Model presets') as HTMLButtonElement
        presetTab.click()
        flushSync()
        const row = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('gemini-3.8-flash')) as HTMLButtonElement
        row.click()
        flushSync()
        expect(onChange).toHaveBeenCalledWith('modelpreset:::p38')
    })

    it('opens on the preset tab and names the preset when one is selected', async () => {
        const { target } = await open('modelpreset:::p37')
        expect(target.querySelector('button.bg-darkbutton')?.textContent).toContain('Vertex AI 5 · gemini-3.7-flash')
        const selected = [...document.querySelectorAll('.rounded-md.border button')].find((button) => button.classList.contains('bg-selected'))
        expect(selected?.textContent?.trim()).toBe('Model presets')
    })
})
