import { readFileSync } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'
import { writable } from 'svelte/store'
import { buildModuleJson, readSource } from '../../../../modules/card-battle/build.mjs'
import { ParseMarkdown } from '../parser.svelte'

const fixture = vi.hoisted(() => ({ display: '', modules: [] as [string, string, string][] }))

vi.mock('../../storage/database.svelte', () => ({
    appVer: '1234.5.67',
    getCurrentCharacter: () => ({ image: 'synthetic/bot.webp' }),
    getDatabase: () => ({}),
}))
vi.mock('../../globalApi.svelte', () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: async (path: string) => `/resolved/${path}`,
}))
vi.mock('../../stores.svelte', () => ({
    DBState: { db: { characters: [], globalChatVariables: {}, templateDefaultVariables: '' } },
    selIdState: { selId: 0 },
    selectedCharID: writable(0),
}))
vi.mock('../../util', async (original) => ({
    ...await original<typeof import('../../util')>(),
    getUserIcon: () => 'synthetic/user.webp',
}))
vi.mock('../../process/modules', () => ({
    getModuleAssets: () => fixture.modules,
    getModuleLorebooks: () => [],
    getModules: () => [{ id: 'synthetic-module', assets: fixture.modules }],
}))
vi.mock('../../process/scripts', () => ({
    processScriptFull: async () => ({ data: fixture.display, emoChanged: false }),
}))

describe('card battle display media compatibility', () => {
    test('resolves raw/path and profile macros introduced by editDisplay, including CSS backgrounds', async () => {
        fixture.modules = buildModuleJson(readSource()).module.assets.map(([name, , ext]) => [name, `synthetic/${name}.${ext}`, ext])
        fixture.display = `<div class="cbx-stage" style="background-image:url('{{raw::cb-art-bg-stage}}')">
<img class="cbx-icon" src="{{path::cb-art-ic-attack}}">
<img src="{{raw::cb-foe-clockwork}}"><img src="{{source::char}}"><img src="{{source::user}}"></div>`
        const char = { type: 'simple', chaId: 'synthetic-card-battle', customscript: [], triggerscript: [],
            additionalAssets: [['cb-foe-clockwork', 'synthetic/clockwork.webp', 'webp']] } as any
        const out = await ParseMarkdown('synthetic hidden state', char, 'back', 0)
        expect(out).not.toContain('{{')
        expect(out).toContain('/resolved/synthetic/cb-art-bg-stage.webp')
        expect(out).toContain('/resolved/synthetic/cb-art-ic-attack.webp')
        expect(out).toContain('/resolved/synthetic/clockwork.webp')
        expect(out).toContain('/resolved/synthetic/bot.webp')
        expect(out).toContain('/resolved/synthetic/user.webp')
        expect(out).toContain('class="x-risu-cbx-stage"')
    })

    test('keeps the module CSS scoped, inverse board transforms, keyframes and reduced motion rules', async () => {
        const code = readSource()
        const base = code.match(/CB.CSS = \(\[\[([\s\S]*?)\]\]/)?.[1]
        const art = code.match(/CB.ART_CSS = \[\[([\s\S]*?)\]\]/)?.[1]
        expect(base && art).toBeTruthy()
        fixture.display = `<style>${base}${art}</style><div class="cbx-root"><div class="cbx-spot"><div class="cbx-stand">synthetic</div></div></div>`
        const out = await ParseMarkdown(fixture.display, null, 'back')
        const body = new DOMParser().parseFromString(out, 'text/html')
        expect(body.querySelectorAll('style')).toHaveLength(1)
        const css = body.querySelector('style')!.textContent
        expect(css).toContain('.chattext .x-risu-cbx-view-board .x-risu-cbx-stand')
        expect(css).toContain('rotateX(-46deg)')
        expect(css).toContain('rotateX(-50deg)')
        expect(css).toContain('@keyframes cbSummon')
        expect(css).toContain('prefers-reduced-motion:reduce')
        expect(css).toContain('-webkit-text-stroke')
        // The chat's prose styles give every img a 2em margin, which pushed card
        // art out of its window and blew the intent pill up into a circle.
        expect(css).toMatch(/\.chattext \.x-risu-cbx-root img\s*\{\s*margin:\s*0(px)?\s*!important/)
    })

    test('Risu preserves web-font at-rules, while this module uses a local bold system stack', async () => {
        fixture.display = '<style>@import url("https://example.invalid/synthetic.css");@font-face{font-family:synthetic;src:url("https://example.invalid/synthetic.woff2")}.synthetic{font-family:synthetic}</style>'
        const out = await ParseMarkdown(fixture.display, null, 'back')
        expect(out).toContain('@font-face')
        expect(out).toContain('@import')
        expect(out).toContain('.chattext .x-risu-synthetic')
        expect(readFileSync('modules/card-battle/card-battle.lua', 'utf8')).not.toContain('@import')
    })
})
