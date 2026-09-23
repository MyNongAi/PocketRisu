// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'

const mocks = vi.hoisted(() => ({
    getFileSrc: vi.fn(async (path: string) => `/files/${path}`),
    detectStealthMetadata: vi.fn(async (): Promise<string> => 'present'),
}))

vi.mock('src/ts/globalApi.svelte', () => ({ getFileSrc: mocks.getFileSrc }))
vi.mock('src/ts/media/stealthMetadata', () => ({
    canCarryStealth: (extension: string) => ['png', 'webp'].includes(extension),
    detectStealthMetadata: mocks.detectStealthMetadata,
}))

import StealthStatusIcon from './StealthStatusIcon.svelte'
import { resetStealthStatuses } from 'src/ts/media/stealthStatusStore.svelte'

class TestIntersectionObserver {
    static latest: TestIntersectionObserver | undefined
    readonly observe = vi.fn()
    readonly disconnect = vi.fn()
    constructor(private readonly callback: IntersectionObserverCallback) {
        TestIntersectionObserver.latest = this
    }
    enter() {
        const target = this.observe.mock.calls[0]?.[0] as Element
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
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
    resetStealthStatuses()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
})

async function render(path: string, extension = 'png') {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob([new Uint8Array(4)]))))
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(StealthStatusIcon, { target, props: { path, extension } }))
    await tick()
    return target.querySelector('[data-stealth]') as HTMLElement
}

async function settle() {
    for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        flushSync()
    }
}

describe('StealthStatusIcon', () => {
    it('checks nothing until the row scrolls into view, then turns green', async () => {
        const icon = await render('assets/present.png')
        await settle()
        expect(mocks.detectStealthMetadata).not.toHaveBeenCalled()
        expect(icon.dataset.stealth).toBe('pending')

        TestIntersectionObserver.latest!.enter()
        await settle()

        expect(icon.dataset.stealth).toBe('present')
        expect(icon.classList.contains('text-green-500')).toBe(true)
        expect(icon.classList.contains('text-red-500')).toBe(false)
    })

    it('turns red when the payload is gone', async () => {
        mocks.detectStealthMetadata.mockResolvedValueOnce('absent')
        const icon = await render('assets/absent.webp', 'webp')
        TestIntersectionObserver.latest!.enter()
        await settle()

        expect(icon.dataset.stealth).toBe('absent')
        expect(icon.classList.contains('text-red-500')).toBe(true)
    })

    it('keeps the normal colour for files that cannot carry it', async () => {
        const icon = await render('assets/voice.mp3', 'mp3')
        TestIntersectionObserver.latest!.enter()
        await settle()

        expect(icon.dataset.stealth).toBe('unsupported')
        expect(icon.classList.contains('text-green-500')).toBe(false)
        expect(icon.classList.contains('text-red-500')).toBe(false)
        expect(mocks.getFileSrc).not.toHaveBeenCalled()
    })
})
