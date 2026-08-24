// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet, mount, tick, unmount, type Snippet } from 'svelte'
import MeasuredVirtualList from './MeasuredVirtualList.svelte'

class TestResizeObserver {
    static instances: TestResizeObserver[] = []
    readonly observed = new Set<Element>()

    constructor(private readonly callback: ResizeObserverCallback) {
        TestResizeObserver.instances.push(this)
    }

    observe(target: Element) { this.observed.add(target) }
    unobserve(target: Element) { this.observed.delete(target) }
    disconnect() { this.observed.clear() }
    takeRecords() { return [] }

    emit(target: Element, height: number) {
        this.callback([{
            target,
            borderBoxSize: [{ blockSize: height, inlineSize: 320 }],
        } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
    }
}

const mounted: unknown[] = []
let originalClientHeight: PropertyDescriptor | undefined

const children = createRawSnippet(() => ({
    render: () => '<span class="test-row">row</span>',
})) as unknown as Snippet<[number, number]>

function renderList(itemCount: number, smallListThreshold = 10) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(MeasuredVirtualList, {
        target,
        props: {
            items: Array.from({ length: itemCount }, (_, index) => index),
            estimatedItemHeight: 50,
            overscan: 1,
            smallListThreshold,
            ariaLabel: 'Measured modules',
            key: (item: number) => item,
            children,
        },
    }))
    return target
}

beforeEach(() => {
    TestResizeObserver.instances = []
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get() {
            return this.hasAttribute('data-measured-virtual-list') ? 200 : 0
        },
    })
})

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((component) => unmount(component as never)))
    document.body.replaceChildren()
    TestResizeObserver.instances = []
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if(originalClientHeight){
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
    }else{
        delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    }
})

describe('MeasuredVirtualList', () => {
    it('falls back to natural rendering for small catalogs', async () => {
        const target = renderList(4, 10)
        await tick()

        const viewport = target.querySelector<HTMLElement>('[data-measured-virtual-list]')!
        expect(viewport.dataset.virtualMode).toBe('plain')
        expect(viewport.getAttribute('role')).toBe('region')
        expect(viewport.querySelector('[role="list"]')).not.toBeNull()
        expect(viewport.getAttribute('aria-label')).toBe('Measured modules')
        expect(viewport.querySelectorAll('[role="listitem"]')).toHaveLength(4)
        expect(viewport.querySelector('[data-virtual-total]')).toBeNull()
    })

    it('mounts a bounded window and moves it on scroll', async () => {
        const target = renderList(100, 10)
        await tick()
        await tick()

        const viewport = target.querySelector<HTMLElement>('[data-measured-virtual-list]')!
        expect(viewport.dataset.virtualMode).toBe('windowed')
        expect(viewport.querySelectorAll('[role="listitem"]').length).toBeLessThanOrEqual(7)
        expect(viewport.querySelectorAll('[role="listitem"]').length).toBeGreaterThan(0)

        viewport.scrollTop = 2_000
        viewport.dispatchEvent(new Event('scroll'))
        await tick()

        const indexes = Array.from(viewport.querySelectorAll<HTMLElement>('[data-virtual-index]'))
            .map((row) => Number(row.dataset.virtualIndex))
        expect(indexes[0]).toBe(39)
        expect(indexes.at(-1)).toBe(44)
    })

    it('uses ResizeObserver measurements without moving the top anchor', async () => {
        const target = renderList(100, 10)
        await tick()
        await tick()
        const viewport = target.querySelector<HTMLElement>('[data-measured-virtual-list]')!

        viewport.scrollTop = 2_000
        viewport.dispatchEvent(new Event('scroll'))
        await tick()

        const precedingRow = viewport.querySelector<HTMLElement>('[data-virtual-index="39"]')!
        const rowObserver = TestResizeObserver.instances.find((observer) => observer.observed.has(precedingRow))
        expect(rowObserver).toBeDefined()
        rowObserver?.emit(precedingRow, 100)
        await Promise.resolve()
        await tick()

        // Row 39 grew by 50px immediately above row 40, so preserving row 40
        // at the viewport top requires the same 50px scroll adjustment.
        expect(viewport.scrollTop).toBe(2_050)
    })

    it('supports keyboard navigation on the scroll region itself', async () => {
        const target = renderList(100, 10)
        await tick()
        await tick()
        const viewport = target.querySelector<HTMLElement>('[data-measured-virtual-list]')!

        viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
        await tick()
        expect(viewport.scrollTop).toBe(4_800)

        viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
        await tick()
        expect(viewport.scrollTop).toBe(0)
    })
})
