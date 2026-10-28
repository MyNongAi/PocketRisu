// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WHOLE_ASSET_ATTR, WHOLE_RATIO_VAR, backgroundUrl, isCropped, showCroppedAssets, showWholeAssets, wholeBotAssets } from './wholeAssets'

// happy-dom has no layout or image loading: a box's size comes from data-w /
// data-h, and a picture's own size from its file name (`<w>x<h>-<name>`).
beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const width = Number(this.getAttribute('data-w') ?? 0)
        const height = Number(this.getAttribute('data-h') ?? 0)
        return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect
    })
    vi.stubGlobal('Image', class {
        naturalWidth = 0
        naturalHeight = 0
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        set src(url: string) {
            const size = /(\d+)x(\d+)-/.exec(url)
            queueMicrotask(() => {
                if (!size) return this.onerror?.()
                this.naturalWidth = Number(size[1])
                this.naturalHeight = Number(size[2])
                this.onload?.()
            })
        }
    })
})
afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
})

function setup(tag: string) {
    document.body.innerHTML = `
        <div class="screen">
            <div data-pr-bot-background>
                <div class="bg" style="background-image: url('832x1216-${tag}-bg.webp')" data-w="375" data-h="160"></div>
            </div>
            <span class="chattext">
                <div class="strip" style="background-image: url('832x1216-${tag}-a.webp'); background-size: cover" data-w="375" data-h="160" tabindex="0">
                </div>
                <div class="avatar" style="background-image: url('832x1216-${tag}-b.webp')" data-w="90" data-h="90"></div>
                <div class="fits" style="background-image: url('832x1216-${tag}-c.webp')" data-w="250" data-h="365"></div>
                <div class="contain" style="background-image: url('832x1216-${tag}-d.webp'); background-size: contain" data-w="375" data-h="160"></div>
                <div class="panel" style="background-image: url('832x1216-${tag}-e.webp')" data-w="375" data-h="160">HP 100</div>
                <div class="gradient" style="background-image: linear-gradient(red, blue)" data-w="375" data-h="160"></div>
                <img class="cover" src="cover.webp" style="object-fit: cover" data-w="375" data-h="160">
                <img class="plain" src="plain.webp" data-w="375" data-h="160">
            </span>
        </div>`
    for (const image of Array.from(document.querySelectorAll('img'))) {
        Object.defineProperty(image, 'complete', { value: true })
        Object.defineProperty(image, 'naturalWidth', { value: 832 })
        Object.defineProperty(image, 'naturalHeight', { value: 1216 })
    }
    return document.querySelector('.screen')!
}

const marked = (screen: Element) => Array.from(screen.querySelectorAll(`[${WHOLE_ASSET_ATTR}]`)).map((element) => element.className)

describe('whole assets', () => {
    it('tells a cropped box from one at the picture ratio', () => {
        expect(isCropped({ width: 375, height: 160 }, { width: 832, height: 1216 })).toBe(true)
        expect(isCropped({ width: 250, height: 365 }, { width: 832, height: 1216 })).toBe(false)
        expect(isCropped({ width: 0, height: 0 }, { width: 832, height: 1216 })).toBe(false)
    })

    it('reads the one picture of a background', () => {
        expect(backgroundUrl('url("https://x/a.webp")')).toBe('https://x/a.webp')
        expect(backgroundUrl("url('a.webp')")).toBe('a.webp')
        expect(backgroundUrl('url(a.webp)')).toBe('a.webp')
        expect(backgroundUrl('none')).toBeNull()
        expect(backgroundUrl('linear-gradient(red, blue)')).toBeNull()
        expect(backgroundUrl('url(a.webp), url(b.webp)')).toBeNull()
    })

    it('shows a cropped picture in a message whole, at its own ratio', async () => {
        const screen = setup('mark')
        expect(await showWholeAssets(screen)).toBe(2)
        // not: a narrow avatar, a box already at the ratio, a contained picture,
        // a panel with text, a gradient, a plain <img>, the background layer
        expect(marked(screen)).toEqual(['strip', 'cover'])
        const strip = screen.querySelector<HTMLElement>('.strip')!
        expect(strip.style.getPropertyValue(WHOLE_RATIO_VAR)).toBe('832 / 1216')
        // a second pass finds nothing new
        expect(await showWholeAssets(screen)).toBe(0)
    })

    it('puts the crop back', async () => {
        const screen = setup('unmark')
        await showWholeAssets(screen)
        showCroppedAssets(screen)
        expect(marked(screen)).toEqual([])
        expect(screen.querySelector<HTMLElement>('.strip')!.style.getPropertyValue(WHOLE_RATIO_VAR)).toBe('')
    })

    it('follows the switch', async () => {
        const screen = setup('action') as HTMLElement
        const action = wholeBotAssets(screen, true)
        await vi.waitFor(() => expect(marked(screen)).toEqual(['strip', 'cover']))
        action.update(false)
        expect(marked(screen)).toEqual([])
        action.update(true)
        await vi.waitFor(() => expect(marked(screen)).toEqual(['strip', 'cover']))
        action.destroy()
        expect(marked(screen)).toEqual([])
    })
})
