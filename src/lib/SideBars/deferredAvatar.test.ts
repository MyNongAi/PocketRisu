// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import BarIcon from './BarIcon.svelte'

class TestIntersectionObserver {
    static latest: TestIntersectionObserver | undefined
    readonly observe = vi.fn()
    readonly disconnect = vi.fn()

    constructor(private readonly callback: IntersectionObserverCallback) {
        TestIntersectionObserver.latest = this
    }

    intersect() {
        this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }

    unobserve() {}
    takeRecords() { return [] }
    readonly root = null
    readonly rootMargin = ''
    readonly thresholds = []
}

const mounted: unknown[] = []

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((component) => unmount(component as never)))
    document.body.replaceChildren()
    TestIntersectionObserver.latest = undefined
    vi.unstubAllGlobals()
})

describe('deferred sidebar images', () => {
    it('does not evaluate a BarIcon image source until it approaches the viewport', async () => {
        vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
        const resolveStyle = vi.fn(() => 'background-image: url("/avatar.webp")')
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted.push(mount(BarIcon, { target, props: { additionalStyle: resolveStyle } }))

        await tick()
        expect(resolveStyle).not.toHaveBeenCalled()
        expect(TestIntersectionObserver.latest?.observe).toHaveBeenCalledOnce()

        TestIntersectionObserver.latest?.intersect()
        await tick()

        expect(resolveStyle).toHaveBeenCalledOnce()
        expect(target.querySelector('button')?.getAttribute('style')).toContain('/avatar.webp')
        expect(TestIntersectionObserver.latest?.disconnect).toHaveBeenCalledOnce()
    })
})
