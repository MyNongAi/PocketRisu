import { afterEach, describe, expect, it, vi } from 'vitest'
import { elementAtPath, elementPath, INNER_SCROLL_SETTLE_MS, keepInnerScroll } from './innerScrollKeeper'

const CARD = '<p>intro</p><div class="card"><div class="panel">a<br>b<br>c</div><div class="tabs">x</div></div>'

function mount(html = CARD) {
    const root = document.createElement('span')
    root.innerHTML = html
    document.body.appendChild(root)
    return root
}

function scrollBy(el: Element, top: number, left = 0) {
    el.scrollTop = top
    el.scrollLeft = left
    el.dispatchEvent(new Event('scroll'))
}

/** MutationObserver callbacks run as a microtask. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
})

describe('element paths', () => {
    it('walks child indices from the root and back', () => {
        const root = mount()
        const panel = root.querySelector('.panel')!
        expect(elementPath(root, panel)).toEqual([1, 0])
        expect(elementAtPath(root, [1, 0])).toBe(panel)
        expect(elementAtPath(root, [1, 5])).toBeNull()
        expect(elementPath(root, document.createElement('div'))).toBeNull()
    })
})

describe('keepInnerScroll', () => {
    it('puts a scrolled panel back after the body is rebuilt', async () => {
        const root = mount()
        const stop = keepInnerScroll(root)
        scrollBy(root.querySelector('.panel')!, 120)
        scrollBy(root.querySelector('.tabs')!, 0, 40)

        root.innerHTML = CARD
        await flush()

        expect(root.querySelector('.panel')!.scrollTop).toBe(120)
        expect(root.querySelector('.tabs')!.scrollLeft).toBe(40)
        stop()
    })

    it('finds a box by its id when something was added above it', async () => {
        const root = mount('<div id="log" class="panel">a</div>')
        const stop = keepInnerScroll(root)
        scrollBy(root.querySelector('#log')!, 80)

        root.innerHTML = '<p>new line</p><div id="log" class="panel">a</div>'
        await flush()

        expect(root.querySelector('#log')!.scrollTop).toBe(80)
        expect(root.querySelector('p')!.scrollTop).toBe(0)
        stop()
    })

    it('leaves a box of another kind at that place alone', async () => {
        const root = mount()
        const stop = keepInnerScroll(root)
        scrollBy(root.querySelector('.panel')!, 120)

        root.innerHTML = '<p>intro</p><section><ul></ul></section>'
        await flush()

        expect(root.querySelector('ul')!.scrollTop).toBe(0)
        stop()
    })

    it('forgets a box the reader scrolled back to its start', async () => {
        const root = mount()
        const stop = keepInnerScroll(root)
        const panel = root.querySelector('.panel')!
        scrollBy(panel, 120)
        scrollBy(panel, 0)

        root.innerHTML = CARD
        await flush()

        expect(root.querySelector('.panel')!.scrollTop).toBe(0)
        stop()
    })

    it('keeps the target through a clamp while images load, until the reader touches it', async () => {
        const root = mount()
        const stop = keepInnerScroll(root)
        scrollBy(root.querySelector('.panel')!, 300)

        root.innerHTML = CARD
        await flush()
        // The new box is still short (its image not loaded): the browser clamps it.
        const panel = root.querySelector('.panel')!
        scrollBy(panel, 90)
        panel.dispatchEvent(new Event('load'))
        expect(panel.scrollTop).toBe(300)

        // The reader scrolls it themselves: that is the new position.
        panel.dispatchEvent(new Event('pointerdown'))
        scrollBy(panel, 50)
        root.innerHTML = CARD
        await flush()
        expect(root.querySelector('.panel')!.scrollTop).toBe(50)
        stop()
    })

    it('records scrolls again once the settle time has passed', async () => {
        let now = 1000
        vi.spyOn(performance, 'now').mockImplementation(() => now)
        const root = mount()
        const stop = keepInnerScroll(root)
        scrollBy(root.querySelector('.panel')!, 300)
        root.innerHTML = CARD
        await flush()

        now += INNER_SCROLL_SETTLE_MS + 1
        scrollBy(root.querySelector('.panel')!, 70)
        root.innerHTML = CARD
        await flush()
        expect(root.querySelector('.panel')!.scrollTop).toBe(70)
        stop()
    })

    it('a box that survives a change in place keeps its own position, and no other box takes it', async () => {
        const root = mount('<p>intro</p><div class="other">o<br>p<br>q</div><div class="panel">a<br>b<br>c</div>')
        const stop = keepInnerScroll(root)
        const panel = root.querySelector('.panel')!
        scrollBy(panel, 40)
        // A node inserted above the panel (as MorphedHtml does) shifts its path onto .other.
        root.insertBefore(document.createElement('p'), root.querySelector('.other'))
        await flush()
        expect(panel.scrollTop).toBe(40)
        expect(root.querySelector('.other')!.scrollTop).toBe(0)
        stop()
    })

    it('stops after cleanup', async () => {
        const root = mount()
        const stop = keepInnerScroll(root)
        scrollBy(root.querySelector('.panel')!, 120)
        stop()

        root.innerHTML = CARD
        await flush()
        expect(root.querySelector('.panel')!.scrollTop).toBe(0)
    })
})
