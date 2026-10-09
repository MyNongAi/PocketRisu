// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'

const mocks = vi.hoisted(() => ({
    db: {
        selectedPersona: 1,
        characters: [{ chatPage: 0, chats: [{ bindedPersona: 'beta' }] }],
        personas: [
            { id: 'alpha', name: 'Alpha', note: 'First', icon: 'assets/alpha.png', personaPrompt: '' },
            { id: 'beta', name: 'Beta', note: 'Selected', icon: 'external://local/beta', personaPrompt: '' },
            { id: 'empty', name: 'No Image', note: '', icon: '', personaPrompt: '' },
        ],
    },
    changeUserPersona: vi.fn(),
    updatePersonaText: vi.fn(),
    getFileThumbnailSrc: vi.fn(async (path: string) => `/thumbnail/${encodeURIComponent(path)}`),
    getFileSrc: vi.fn(async (path: string) => `/original/${encodeURIComponent(path)}`),
    saveAsset: vi.fn(),
}))

vi.mock('src/ts/stores.svelte', () => ({
    DBState: { db: mocks.db },
    selIdState: { selId: -1 },
    selectedCharID: {
        subscribe(run: (value: number) => void) {
            run(0)
            return () => {}
        },
    },
}))
vi.mock('src/ts/persona', () => ({ changeUserPersona: mocks.changeUserPersona, updatePersonaText: mocks.updatePersonaText }))
vi.mock('src/ts/globalApi.svelte', () => ({
    getFileThumbnailSrc: mocks.getFileThumbnailSrc,
    getFileSrc: mocks.getFileSrc,
    saveAsset: mocks.saveAsset,
}))

import ListedPersona from './listedPersona.svelte'

class TestIntersectionObserver {
    static instances: TestIntersectionObserver[] = []
    readonly observe = vi.fn()
    readonly disconnect = vi.fn()

    constructor(private readonly callback: IntersectionObserverCallback) {
        TestIntersectionObserver.instances.push(this)
    }

    intersect() {
        const target = this.observe.mock.calls[0]?.[0] as Element
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }

    unobserve() {}
    takeRecords() { return [] }
    readonly root = null
    readonly rootMargin = ''
    readonly thresholds = []
}

let mounted: unknown[] = []

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((component) => unmount(component as never)))
    document.body.replaceChildren()
    TestIntersectionObserver.instances = []
    mocks.changeUserPersona.mockReset()
    mocks.getFileThumbnailSrc.mockClear()
    mocks.getFileSrc.mockClear()
    vi.unstubAllGlobals()
})

describe('persona image picker', () => {
    it('renders image cards, defers thumbnails, and returns the selected index', async () => {
        vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
        const target = document.createElement('div')
        document.body.appendChild(target)
        const onSelect = vi.fn()
        const close = vi.fn()

        mounted.push(mount(ListedPersona, { target, props: { onSelect, close } }))
        await tick()

        // The chat has Beta bound: the popup opens on its edit tab.
        const tabs = target.querySelectorAll<HTMLButtonElement>('[role="tab"]')
        expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')
        expect(target.querySelector<HTMLInputElement>('[data-persona-bind-edit] input')?.value).toBe('Beta')
        tabs[0].click()
        await tick()

        const beta = target.querySelector<HTMLButtonElement>('button[aria-label="Beta"]')
        expect(beta).not.toBeNull()
        expect(beta?.getAttribute('aria-pressed')).toBe('true')
        expect(target.querySelector('button[aria-label="No Image"]')?.textContent).toContain('No Image')
        expect(mocks.getFileThumbnailSrc).not.toHaveBeenCalled()

        TestIntersectionObserver.instances.forEach((observer) => observer.intersect())
        await tick()
        await Promise.resolve()
        await tick()

        expect(mocks.getFileThumbnailSrc).toHaveBeenCalledTimes(2)
        expect(target.querySelectorAll('img')).toHaveLength(2)

        beta?.click()
        await tick()
        expect(onSelect).toHaveBeenCalledWith(1)
        expect(mocks.changeUserPersona).not.toHaveBeenCalled()

        // Binding stays open on the edit tab for that persona; only X closes.
        expect(close).not.toHaveBeenCalled()
        const name = target.querySelector<HTMLInputElement>('[data-persona-bind-edit] input')
        expect(name?.value).toBe('Beta')
        name!.value = 'Beta 2'
        name!.dispatchEvent(new Event('input', { bubbles: true }))
        expect(mocks.updatePersonaText).toHaveBeenCalledWith(1, { name: 'Beta 2' })
        target.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label]:not([role="tab"])')?.click()
        expect(close).toHaveBeenCalledOnce()
    })

    it('opens on the list while the chat has no persona bound', async () => {
        vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
        const chat = mocks.db.characters[0].chats[0]
        chat.bindedPersona = ''
        try {
            const target = document.createElement('div')
            document.body.appendChild(target)
            mounted.push(mount(ListedPersona, { target, props: { onSelect: vi.fn(), close: vi.fn() } }))
            await tick()
            expect(target.querySelector('[role="tab"]')?.getAttribute('aria-selected')).toBe('true')
            expect(target.querySelector('button[aria-label="Beta"]')).not.toBeNull()
        } finally {
            chat.bindedPersona = 'beta'
        }
    })

    it('changes the global persona when no binding callback is supplied', async () => {
        vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
        const target = document.createElement('div')
        document.body.appendChild(target)
        const close = vi.fn()

        mounted.push(mount(ListedPersona, { target, props: { close } }))
        await tick()
        target.querySelector<HTMLButtonElement>('button[aria-label="Alpha"]')?.click()
        await tick()

        expect(mocks.changeUserPersona).toHaveBeenCalledWith(0)
        expect(close).toHaveBeenCalledOnce()
    })
})
