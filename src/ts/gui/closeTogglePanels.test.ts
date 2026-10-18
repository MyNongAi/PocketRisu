// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { closeTogglePanels, looksLikeCloseControl } from './closeTogglePanels'

afterEach(() => { document.body.innerHTML = '' })

function setup() {
    document.body.innerHTML = `
        <style>
            .shop-panel, .heart, .inv-panel { display: none; }
            .shop-toggle:checked ~ .shop-panel { display: block; }
            .inv-toggle:checked ~ .inv-panel { display: block; }
            #character-toggle:checked ~ .heart { display: block; }
        </style>
        <div class="message">
            <div class="heart-wrap">
                <input type="checkbox" id="character-toggle" checked>
                <div class="heart"><button risu-trigger="adjust_plus_5">+5</button></div>
            </div>
            <div class="sheet">
                <input type="checkbox" class="inv-toggle" checked>
                <input type="checkbox" class="shop-toggle" checked>
                <label class="modal-backdrop"></label>
                <div class="inv-panel"><button risu-trigger="inv_hide" aria-label="close">✕</button></div>
                <div class="shop-panel"><div class="head"><button risu-trigger="shop_hide" class="inv-close shop-close">✕</button></div></div>
            </div>
        </div>`
    const root = document.querySelector('.message')!
    const box = (selector: string) => document.querySelector(selector) as HTMLInputElement
    return { root, box }
}

describe('closing a toggle panel from a trigger button', () => {
    it('tells close buttons from other trigger buttons', () => {
        const { root } = setup()
        expect(looksLikeCloseControl(root.querySelector('[risu-trigger="shop_hide"]')!)).toBe(true)
        expect(looksLikeCloseControl(root.querySelector('[risu-trigger="inv_hide"]')!)).toBe(true)
        expect(looksLikeCloseControl(root.querySelector('[risu-trigger="adjust_plus_5"]')!)).toBe(false)
    })

    it('unticks only the box that shows the panel the button is in', () => {
        const { root, box } = setup()
        expect(closeTogglePanels(root.querySelector('[risu-trigger="shop_hide"]')!, root)).toBe(1)
        expect(box('.shop-toggle').checked).toBe(false)
        expect(box('.inv-toggle').checked).toBe(true)
        expect(box('#character-toggle').checked).toBe(true)
    })

    it('leaves the boxes alone for a button outside any toggle panel', () => {
        const { root, box } = setup()
        const loose = document.createElement('button')
        loose.setAttribute('risu-trigger', 'close_all')
        root.append(loose)
        expect(closeTogglePanels(loose, root)).toBe(0)
        expect(box('.shop-toggle').checked).toBe(true)
    })
})
