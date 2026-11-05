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
        expect(css).toContain('rotateX(-56deg)')
        for (const name of ['cbRise', 'cbLand', 'cbGo', 'cbFall', 'cbFlip', 'cbSummonRing']) expect(css).toContain(`@keyframes ${name}`)
        // A creature's lunge reads its target from custom properties on the element.
        expect(css).toMatch(/@keyframes cbGo\s*\{[^@]*translate\(var\(--tx\),\s*var\(--ty\)\)/)
        expect(css).toContain('prefers-reduced-motion:reduce')
        expect(css).toContain('-webkit-text-stroke')
        // The chat's prose styles give every img a 2em margin, which pushed card
        // art out of its window and blew the intent pill up into a circle.
        expect(css).toMatch(/\.chattext \.x-risu-cbx-root img\s*\{\s*margin:\s*0(px)?\s*!important/)
    })

    test('keeps the 1.0 field markup: slot buttons, the lying card, the standing creature, its lunge and the creature card frame', async () => {
        const code = readSource()
        const base = code.match(/CB.CSS = \(\[\[([\s\S]*?)\]\]/)?.[1]
        const art = code.match(/CB.ART_CSS = \[\[([\s\S]*?)\]\]/)?.[1]
        fixture.modules = buildModuleJson(code).module.assets.map(([name, , ext]) => [name, `synthetic/${name}.${ext}`, ext])
        // The shape CB.lanes, CB.fieldCard and CB.creatureFace draw (the Lua
        // tests check the Lua draws these same pieces).
        fixture.display = `<style>${base}${art}</style><div class="cbx-root"><div class="cbx-stage cbx-view-board"><div class="cbx-floor"><div class="cbx-plane">`
            + '<div class="cbx-slot cbx-ours cbx-target" risu-btn="cb|play|1|7|L3" style="left:68%;top:57%"><span class="cbx-laneno">3</span></div>'
            + '<div class="cbx-slot cbx-theirs cbx-aimable" risu-btn="cb|hit|2|7|E1" style="left:10%;top:12%"><div class="cbx-unit cbx-die">'
            + '<div class="cbx-fcard cbx-foecard" style="border-color:#c0453c;animation-delay:0.55s"><div class="cbx-stars">★</div><div class="cbx-fart">'
            + '<span class="cbx-picture"><img src="{{raw::cb-art-foe-imp}}" alt="👹"><span class="cbx-fallback">👹</span></span></div></div>'
            + '<div class="cbx-mover cbx-go" style="--tx:0%;--ty:131%;animation-delay:0.30s"><div class="cbx-spot"><div class="cbx-stand"><div class="cbx-crt cbx-hit" style="animation-delay:0.55s">'
            + '<span class="cbx-picture"><img src="{{raw::cb-art-foe-imp}}" alt="👹"><span class="cbx-fallback">👹</span></span>'
            + '<div class="cbx-mstats"><span class="cbx-matk"><img class="cbx-icon" src="{{raw::cb-art-ic-attack}}" alt="⚔"><span>3</span></span>'
            + '<span class="cbx-mhp cbx-low"><img class="cbx-icon" src="{{raw::cb-art-ic-heal}}" alt="❤"><span>0</span></span></div>'
            + '<i class="cbx-impact" style="animation-delay:0.30s"></i></div></div></div></div></div></div>'
            + '</div></div></div>'
            + '<div class="cbx-card cbx-sum" style="width:84px;height:120px"><div class="cbx-cost">1</div><div class="cbx-mframe" style="font-size:10px;border-color:#e6b450">'
            + '<div class="cbx-mname"><span class="cbx-mtitle" style="font-size:.85em">수정 여우</span><span class="cbx-attr" style="background:#ffd65c">빛</span></div>'
            + '<div class="cbx-stars">★★★</div><div class="cbx-mart"><span class="cbx-picture"><img src="{{raw::cb-art-ally-fox}}" alt="🦊"></span></div>'
            + '<div class="cbx-mtext">1장 뽑기</div></div></div></div>'
        const out = await ParseMarkdown('synthetic hidden state', { type: 'simple', chaId: 'synthetic-card-battle', customscript: [], triggerscript: [], additionalAssets: [] } as any, 'back', 0)
        const body = new DOMParser().parseFromString(out, 'text/html')
        const target = body.querySelector('[risu-btn="cb|play|1|7|L3"]')
        expect(target?.getAttribute('class')).toBe('x-risu-cbx-slot x-risu-cbx-ours x-risu-cbx-target')
        expect(body.querySelector('[risu-btn="cb|hit|2|7|E1"]')).not.toBeNull()
        const mover = body.querySelector('.x-risu-cbx-mover')
        expect(mover?.getAttribute('style')).toContain('--tx:0%;--ty:131%')
        expect(body.querySelector('.x-risu-cbx-unit > .x-risu-cbx-fcard + .x-risu-cbx-mover .x-risu-cbx-stand > .x-risu-cbx-crt')).not.toBeNull()
        expect(body.querySelector('.x-risu-cbx-crt .x-risu-cbx-matk')?.textContent).toBe('3')
        expect(body.querySelector('i.x-risu-cbx-impact')).not.toBeNull()
        expect(body.querySelector('.x-risu-cbx-mframe .x-risu-cbx-attr')?.textContent).toBe('빛')
        expect(out).toContain('/resolved/synthetic/cb-art-ally-fox.webp')
        expect(out).toContain('/resolved/synthetic/cb-art-ic-heal.webp')
        expect(out).not.toContain('{{')
        const css = body.querySelector('style')!.textContent
        expect(css).toContain('.chattext .x-risu-cbx-unit,.chattext .x-risu-cbx-mover')
        expect(css).toContain('.chattext .x-risu-cbx-crt>.x-risu-cbx-mstats')
        // Every picture the field and the frames add sits under .cbx-root, whose images lose the chat's margins.
        expect(css).toMatch(/\.chattext \.x-risu-cbx-root img\s*\{\s*margin:\s*0(px)?\s*!important/)
        expect(body.querySelectorAll('.x-risu-cbx-root img').length).toBe(body.querySelectorAll('img').length)
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
