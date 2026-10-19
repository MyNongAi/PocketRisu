// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOT_BACKGROUND_ATTR, FLOATING_HIDDEN_ATTR, findFloatingLaunchers, fixedSelectors, hideFloatingLaunchers, showFloatingLaunchers } from './floatingBotControls'

// happy-dom has no layout: a box's size comes from data-w / data-h.
beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const width = Number(this.getAttribute('data-w') ?? 0)
        const height = Number(this.getAttribute('data-h') ?? 0)
        return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect
    })
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
})
afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
})

function setup() {
    document.body.innerHTML = `
        <style>
            .x-risu-buttons-container { position: fixed; right: 8px; bottom: 80px; }
            .x-risu-panel { position: fixed; inset: 40px; display: none; }
            #x-risu-map:checked ~ .x-risu-panel { display: block; }
            .x-risu-hud { position: fixed; top: 0; }
            .fixed { position: fixed; }
        </style>
        <div class="screen">
            <button class="fixed app-dock" data-w="40" data-h="40">app</button>
            <div ${BOT_BACKGROUND_ATTR}>
                <input type="checkbox" id="x-risu-map">
                <div class="x-risu-buttons-container" data-w="48" data-h="160">
                    <label for="x-risu-map">지도</label>
                </div>
                <div class="x-risu-panel" data-w="320" data-h="720"><label for="x-risu-map">✕</label></div>
                <div class="x-risu-hud" data-w="400" data-h="30">HP 100</div>
            </div>
            <span class="chattext">
                <p>text <button risu-trigger="next">다음</button></p>
                <div style="position: fixed; left: 0; bottom: 0" data-w="56" data-h="56"><button risu-btn="menu">≡</button></div>
            </span>
        </div>`
    return document.querySelector('.screen')!
}

describe('floating bot controls', () => {
    it('reads the fixed rules of the page', () => {
        setup()
        expect(fixedSelectors(document)).toEqual(expect.arrayContaining(['.x-risu-buttons-container', '.x-risu-panel', '.x-risu-hud']))
    })

    it('finds small fixed launchers in bot markup only', () => {
        const screen = setup()
        const found = findFloatingLaunchers(screen)
        expect(found.map((element) => element.className || element.getAttribute('style'))).toEqual(['x-risu-buttons-container', 'position: fixed; left: 0; bottom: 0'])
        // not: the app's own fixed dock, the closed popup, a HUD with no control, a button in the text
    })

    it('leaves an open popup alone (it is larger than a launcher)', () => {
        const screen = setup()
        ;(document.getElementById('x-risu-map') as HTMLInputElement).checked = true
        const found = findFloatingLaunchers(screen)
        expect(found.some((element) => element.classList.contains('x-risu-panel'))).toBe(false)
    })

    it('marks and unmarks', () => {
        const screen = setup()
        expect(hideFloatingLaunchers(screen)).toBe(2)
        expect(screen.querySelectorAll(`[${FLOATING_HIDDEN_ATTR}]`).length).toBe(2)
        // a second pass finds nothing new (hidden ones stay hidden)
        expect(hideFloatingLaunchers(screen)).toBe(0)
        showFloatingLaunchers(screen)
        expect(screen.querySelectorAll(`[${FLOATING_HIDDEN_ATTR}]`).length).toBe(0)
    })
})
