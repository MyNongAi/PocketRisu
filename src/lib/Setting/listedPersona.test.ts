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
import { language } from 'src/lang'

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

    it('edits the global persona on the edit tab while the chat uses the default', async () => {
        vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
        const chat = mocks.db.characters[0].chats[0]
        chat.bindedPersona = ''
        mocks.updatePersonaText.mockClear()
        try {
            const target = document.createElement('div')
            document.body.appendChild(target)
            const onSelect = vi.fn()
            mounted.push(mount(ListedPersona, { target, props: { onSelect, close: vi.fn() } }))
            await tick()
            const tabs = target.querySelectorAll<HTMLButtonElement>('[role="tab"]')
            expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')
            // selectedPersona is Beta: the default edits it, and nothing gets bound.
            const name = target.querySelector<HTMLInputElement>('[data-persona-bind-edit] input')
            expect(name?.value).toBe('Beta')
            name!.value = 'Beta 3'
            name!.dispatchEvent(new Event('input', { bubbles: true }))
            expect(mocks.updatePersonaText).toHaveBeenCalledWith(1, { name: 'Beta 3' })
            expect(onSelect).not.toHaveBeenCalled()
            // The list tab still offers the personas to bind.
            tabs[0].click()
            await tick()
            expect(target.querySelector('button[aria-label="Beta"]')).not.toBeNull()
        } finally {
            chat.bindedPersona = 'beta'
        }
    })

    it('binds a name typed on the blank persona as the chat\'s name only, and a description makes it a persona', async () => {
        vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
        const db = mocks.db as typeof mocks.db & { nodeOnlyPersonaNames?: Record<string, string> }
        const chat = db.characters[0].chats[0]
        const personas = db.personas
        db.personas = [...personas, { id: 'blank', name: '', note: '빈 페르소나', icon: '', personaPrompt: '', nodeOnlyBlank: true } as never]
        chat.bindedPersona = 'blank'
        try {
            const target = document.createElement('div')
            document.body.appendChild(target)
            const onSelect = vi.fn()
            mounted.push(mount(ListedPersona, { target, props: { onSelect, close: vi.fn() } }))
            await tick()
            const name = target.querySelector<HTMLInputElement>('[data-persona-bind-edit] input')!
            name.value = '김'
            name.dispatchEvent(new Event('input', { bubbles: true }))
            await tick()
            // No persona: the chat binds a new id that only names it.
            const id = chat.bindedPersona
            expect(id).not.toBe('blank')
            expect(db.nodeOnlyPersonaNames).toEqual({ [id]: '김' })
            expect(db.personas).toHaveLength(4)
            expect(onSelect).not.toHaveBeenCalled()
            expect(target.querySelector('[data-persona-bind-edit] p')?.textContent).toBe(language.personaBindEditNameOnly)

            const renamed = target.querySelector<HTMLInputElement>('[data-persona-bind-edit] input')!
            renamed.value = '김철수'
            renamed.dispatchEvent(new Event('input', { bubbles: true }))
            expect(db.nodeOnlyPersonaNames).toEqual({ [id]: '김철수' })
            expect(chat.bindedPersona).toBe(id)

            // A description makes it a persona under the same id.
            const description = target.querySelector<HTMLTextAreaElement>('[data-persona-bind-edit] textarea')!
            description.value = 'tall'
            description.dispatchEvent(new Event('input', { bubbles: true }))
            expect(db.personas).toHaveLength(5)
            expect(db.personas[4]).toMatchObject({ id, name: '김철수', personaPrompt: 'tall' })
            expect(db.nodeOnlyPersonaNames).toEqual({})
            expect(chat.bindedPersona).toBe(id)
        } finally {
            db.personas = personas
            delete db.nodeOnlyPersonaNames
            chat.bindedPersona = 'beta'
        }
    })

    it('puts the last applied first while the recent toggle is on, and remembers it', async () => {
        vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
        const empty = mocks.db.personas[2] as typeof mocks.db.personas[number] & { lastAppliedAt?: number }
        empty.lastAppliedAt = 100
        try {
            localStorage.removeItem('risu-persona-sort')
            const target = document.createElement('div')
            document.body.appendChild(target)
            mounted.push(mount(ListedPersona, { target, props: { close: vi.fn() } }))
            await tick()
            const cards = () => [...target.querySelectorAll<HTMLButtonElement>('button[aria-label][aria-pressed]')]
                .map((button) => button.getAttribute('aria-label'))
                .filter((label) => ['Alpha', 'Beta', 'No Image'].includes(label ?? ''))
            expect(cards()).toEqual(['Alpha', 'Beta', 'No Image'])
            const toggle = target.querySelector<HTMLButtonElement>('[data-persona-sort]')!
            expect(toggle.getAttribute('aria-pressed')).toBe('false')
            toggle.click()
            await tick()
            expect(toggle.getAttribute('aria-pressed')).toBe('true')
            expect(cards()).toEqual(['No Image', 'Alpha', 'Beta'])
            expect(localStorage.getItem('risu-persona-sort')).toBe('recent')
        } finally {
            delete empty.lastAppliedAt
            localStorage.removeItem('risu-persona-sort')
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
