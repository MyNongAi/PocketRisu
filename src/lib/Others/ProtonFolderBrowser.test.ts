// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import { language } from 'src/lang'
import type { ProtonEntry, ProtonInspectResult } from 'src/ts/protonShareClient'

const client = vi.hoisted(() => ({
    inspectProtonShare: vi.fn(),
    fetchProtonThumbnails: vi.fn(async () => {}),
}))
vi.mock('src/ts/protonShareClient', () => client)

import ProtonFolderBrowser from './ProtonFolderBrowser.svelte'
import { buildProtonRows, filterProtonRows, formatProtonDate, formatProtonSize, openProtonBrowser, protonBrowserState } from 'src/ts/protonBrowser.svelte'

const file = (linkId: string, name: string, extra: Partial<ProtonEntry> = {}): ProtonEntry =>
    ({ linkId, name, type: 2, size: 2048, mediaType: null, hasThumbnail: false, ...extra })
const folder = (linkId: string, name: string): ProtonEntry =>
    ({ linkId, name, type: 1, size: null, mediaType: null, hasThumbnail: false })

const ROOT: ProtonInspectResult = {
    kind: 'folder',
    name: 'Bots',
    trail: [],
    entries: [
        file('f10', 'card 10.charx'),
        folder('d1', 'Season 2'),
        file('f2', 'card 2.png', { hasThumbnail: true, modifiedAt: new Date(2026, 10, 6, 0, 30).getTime() }),
        file('fx', 'notes.txt'),
    ],
}
const SEASON2: ProtonInspectResult = {
    kind: 'folder',
    name: 'Bots',
    trail: [{ linkId: 'd1', name: 'Season 2' }],
    entries: [file('s1', 'extra.risum')],
}

const mounted: unknown[] = []
afterEach(async () => {
    await Promise.all(mounted.splice(0).map((component) => unmount(component as never)))
    document.body.replaceChildren()
    vi.clearAllMocks()
})

async function settle() {
    for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        flushSync()
    }
}

function rowNames(root: HTMLElement) {
    return [...root.querySelectorAll('li')].map((li) => li.textContent?.replace(/\s+/g, ' ').trim())
}

function checkboxFor(root: HTMLElement, name: string) {
    const li = [...root.querySelectorAll('li')].find((row) => row.textContent?.includes(name))
    return li?.querySelector('input[type=checkbox]') as HTMLInputElement
}

describe('buildProtonRows', () => {
    it('puts folders first, sorts naturally, and marks what can be imported', () => {
        const rows = buildProtonRows(ROOT.entries)
        expect(rows.map((row) => row.entry.name)).toEqual(['Season 2', 'card 2.png', 'card 10.charx', 'notes.txt'])
        expect(rows.map((row) => row.kind)).toEqual(['folder', 'character', 'character', 'unsupported'])
        expect(rows.map((row) => row.importable)).toEqual([false, true, true, false])
    })

    it('labels a .charx as a module when the module page opened the link', () => {
        const rows = buildProtonRows(ROOT.entries, 'module')
        expect(rows.find((row) => row.entry.name === 'card 10.charx')?.kind).toBe('module')
        expect(rows.find((row) => row.entry.name === 'card 2.png')?.kind).toBe('character')
    })

    it('formats sizes compactly', () => {
        expect(formatProtonSize(null)).toBe('')
        expect(formatProtonSize(900)).toBe('900 B')
        expect(formatProtonSize(2048)).toBe('2 KB')
        expect(formatProtonSize(39_330_882)).toBe('37.5 MB')
    })
})

describe('filterProtonRows', () => {
    const options = { query: '', onlyImportable: false, newestFirst: false }
    const names = (result: ReturnType<typeof filterProtonRows>) => result.visible.map((row) => row.entry.name)

    it('searches files and folders case-insensitively and trims the query', () => {
        const rows = buildProtonRows(ROOT.entries)
        expect(names(filterProtonRows(rows, { ...options, query: '  CARD  ' }))).toEqual(['card 2.png', 'card 10.charx'])
        expect(names(filterProtonRows(rows, { ...options, query: 'sEAsOn' }))).toEqual(['Season 2'])
        expect(names(filterProtonRows(rows, { ...options, query: 'missing' }))).toEqual([])
    })

    it('hides only unsupported files and counts them across the folder, independently of search', () => {
        const rows = buildProtonRows(ROOT.entries)
        const filtered = filterProtonRows(rows, { ...options, onlyImportable: true })
        expect(names(filtered)).toEqual(['Season 2', 'card 2.png', 'card 10.charx'])
        expect(filtered.hiddenCount).toBe(1)
        expect(filterProtonRows(rows, { ...options, query: 'card', onlyImportable: true }).hiddenCount).toBe(1)
        expect(filterProtonRows(rows, options).hiddenCount).toBe(0)
        expect(names(filterProtonRows(rows, { ...options, query: 'notes', onlyImportable: true }))).toEqual([])
        expect(names(filterProtonRows(rows, { ...options, query: 'notes' }))).toEqual(['notes.txt'])
    })

    const entries = [
        file('f10', 'card 10.charx', { modifiedAt: 2000 }),
        folder('d10', 'Season 10'),
        file('f2', 'card 2.png', { modifiedAt: 1000 }),
        { ...folder('d2', 'Season 2'), modifiedAt: 500 },
        { ...folder('d20', 'Season 20'), modifiedAt: 1500 },
        file('fu', 'card 1.charx'),
        file('fn', 'card 3.charx', { modifiedAt: null }),
        file('ft', 'card 11.charx', { modifiedAt: 2000 }),
    ]

    it('sorts folders first and names naturally even if the input is unsorted', () => {
        const rows = buildProtonRows(entries).reverse()
        const original = [...rows]
        expect(names(filterProtonRows(rows, options))).toEqual([
            'Season 2', 'Season 10', 'Season 20', 'card 1.charx', 'card 2.png', 'card 3.charx', 'card 10.charx', 'card 11.charx',
        ])
        expect(rows).toEqual(original)
    })

    it('sorts newest first within folders and files, with unknown dates last and natural tie-breaking', () => {
        const rows = buildProtonRows(entries)
        const original = [...rows]
        expect(names(filterProtonRows(rows, { ...options, newestFirst: true }))).toEqual([
            'Season 20', 'Season 2', 'Season 10', 'card 10.charx', 'card 11.charx', 'card 2.png', 'card 1.charx', 'card 3.charx',
        ])
        expect(rows).toEqual(original)
    })

    it('treats invalid and nonpositive timestamps as unknown', () => {
        const rows = buildProtonRows([
            file('zero', 'zero.png', { modifiedAt: 0 }),
            file('negative', 'negative.png', { modifiedAt: -1 }),
            file('nan', 'nan.png', { modifiedAt: NaN }),
            file('infinity', 'infinity.png', { modifiedAt: Infinity }),
            file('known', 'known.png', { modifiedAt: 1 }),
        ])
        expect(names(filterProtonRows(rows, { ...options, newestFirst: true }))).toEqual([
            'known.png', 'infinity.png', 'nan.png', 'negative.png', 'zero.png',
        ])
    })
})

describe('formatProtonDate', () => {
    it('formats the local calendar date with zero-padded month and day', () => {
        expect(formatProtonDate(new Date(2026, 0, 2, 0, 30).getTime())).toBe('2026-01-02')
        expect(formatProtonDate(new Date(2026, 10, 6, 23, 30).getTime())).toBe('2026-11-06')
    })

    it('omits missing or invalid dates', () => {
        for (const time of [undefined, null, 0, -1, NaN, Infinity, 1e20]) expect(formatProtonDate(time)).toBe('')
    })
})

describe('ProtonFolderBrowser', () => {
    it('browses into a subfolder and returns picks from several folders with their paths', async () => {
        client.inspectProtonShare.mockResolvedValueOnce(SEASON2)
        const picked = openProtonBrowser('https://drive.proton.me/urls/T#P', '', ROOT)
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted.push(mount(ProtonFolderBrowser, { target }))
        await settle()

        // Previews are asked for only for files Proton has one for.
        expect(client.fetchProtonThumbnails).toHaveBeenCalledWith('https://drive.proton.me/urls/T#P', '', [], ['f2'], expect.any(Function))
        expect(rowNames(target)[0]).toContain('Season 2')
        expect(checkboxFor(target, 'notes.txt')).toBeUndefined()
        ;(target.querySelector('[role=switch]') as HTMLButtonElement).click()
        await settle()
        expect(checkboxFor(target, 'notes.txt').disabled).toBe(true)

        checkboxFor(target, 'card 2.png').click()
        await settle()

        // Open the subfolder.
        const folderButton = [...target.querySelectorAll('li button')].find((b) => b.textContent?.includes('Season 2')) as HTMLButtonElement
        folderButton.click()
        await settle()
        expect(client.inspectProtonShare).toHaveBeenCalledWith('https://drive.proton.me/urls/T#P', '', ['d1'])
        expect(rowNames(target)).toHaveLength(1)
        expect(target.querySelector('nav')?.textContent).toContain('Season 2')

        checkboxFor(target, 'extra.risum').click()
        await settle()

        // Back to the root through the breadcrumb: served from cache, not refetched.
        const rootCrumb = target.querySelector('nav button') as HTMLButtonElement
        rootCrumb.click()
        await settle()
        expect(client.inspectProtonShare).toHaveBeenCalledTimes(1)
        expect(checkboxFor(target, 'card 2.png').checked).toBe(true)

        // Two import buttons (2026-11-08): as bots and as modules.
        const importButtons = [...target.querySelectorAll('button')].filter((b) => /\(2\)/.test(b.textContent ?? '')) as HTMLButtonElement[]
        expect(importButtons.map((b) => b.textContent?.trim())).toEqual([language.protonBrowserImportAsBot(2), language.protonBrowserImportAsModule(2)])
        importButtons[0].click()

        const choice = await picked
        expect(choice?.as).toBe('character')
        expect(choice?.picks.map((pick) => [pick.entry.linkId, pick.path])).toEqual([
            ['f2', []],
            ['s1', ['d1']],
        ])
        expect(protonBrowserState.open).toBe(false)
    })

    it('shows kind, size and local date in the grey line, omitting unavailable parts', async () => {
        void openProtonBrowser('https://drive.proton.me/urls/T#P', '', {
            ...ROOT,
            entries: [...ROOT.entries, file('bare', 'bare.charx', { size: null })],
        })
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted.push(mount(ProtonFolderBrowser, { target }))
        await settle()

        expect(target.querySelector('h2')?.textContent).toBe(language.protonImportTitle)
        const detail = (name: string) => checkboxFor(target, name).closest('li')?.querySelector('.text-xs')?.textContent?.trim()
        expect(detail('card 2.png')).toBe(`${language.protonBrowserKind.character} · 2 KB · 2026-11-06`)
        // A .charx is a bot or a module, as the pressed button says (2026-11-08).
        expect(detail('card 10.charx')).toBe(`${language.protonBrowserKind.either} · 2 KB`)
        expect(detail('bare.charx')).toBe(language.protonBrowserKind.either)
    })

    it('selects only shown files and preserves hidden picks when search and the switch change', async () => {
        const picked = openProtonBrowser('https://drive.proton.me/urls/T#P', '', ROOT)
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted.push(mount(ProtonFolderBrowser, { target }))
        await settle()

        const search = target.querySelector('[data-slot=input]') as HTMLInputElement
        const all = target.querySelector('input[type=checkbox]') as HTMLInputElement
        const searchFor = async (text: string) => {
            search.value = text
            search.dispatchEvent(new Event('input', { bubbles: true }))
            await settle()
        }
        expect(target.textContent).toContain(language.protonImportHidden(1))
        await searchFor('CARD 2')
        expect(rowNames(target)).toHaveLength(1)
        all.click()
        await settle()
        expect(all.checked).toBe(true)
        expect(checkboxFor(target, 'card 2.png').checked).toBe(true)

        await searchFor('card 10')
        expect(all.checked).toBe(false)
        all.click()
        await settle()
        expect(target.textContent).toContain(language.protonBrowserSelected(2))

        await searchFor('notes')
        expect(rowNames(target)).toHaveLength(0)
        expect(all.disabled).toBe(true)
        expect(all.checked).toBe(false)
        ;(target.querySelector('[role=switch]') as HTMLButtonElement).click()
        await settle()
        expect(checkboxFor(target, 'notes.txt').disabled).toBe(true)
        expect(all.disabled).toBe(true)
        expect(target.textContent).not.toContain(language.protonImportHidden(1))

        await searchFor('')
        expect(all.checked).toBe(true)
        expect(checkboxFor(target, 'card 2.png').checked).toBe(true)
        expect(checkboxFor(target, 'card 10.charx').checked).toBe(true)
        ;(target.querySelector('[role=switch]') as HTMLButtonElement).click()
        await settle()
        await searchFor('card 2')
        all.click()
        await settle()
        expect(target.textContent).toContain(language.protonBrowserSelected(1))
        const importButton = [...target.querySelectorAll('button')].find((button) => button.textContent?.trim() === language.protonBrowserImportAsModule(1)) as HTMLButtonElement
        importButton.click()
        const choice = await picked
        expect(choice?.as).toBe('module')
        expect(choice?.picks.map((pick) => pick.entry.linkId)).toEqual(['f10'])
    })

    it('resets search on folder navigation while retaining sort and switch settings', async () => {
        client.inspectProtonShare.mockResolvedValueOnce(SEASON2)
        void openProtonBrowser('https://drive.proton.me/urls/T#P', '', ROOT)
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted.push(mount(ProtonFolderBrowser, { target }))
        await settle()

        const search = target.querySelector('[data-slot=input]') as HTMLInputElement
        const newest = [...target.querySelectorAll('button')].find((button) => button.textContent?.trim() === language.protonImportSortNewest) as HTMLButtonElement
        newest.click()
        await settle()
        expect(newest.getAttribute('aria-pressed')).toBe('true')
        newest.click()
        await settle()
        expect(newest.getAttribute('aria-pressed')).toBe('true')
        ;(target.querySelector('[role=switch]') as HTMLButtonElement).click()
        search.value = 'season'
        search.dispatchEvent(new Event('input', { bubbles: true }))
        await settle()
        ;(target.querySelector('li button') as HTMLButtonElement).click()
        await settle()
        expect(search.value).toBe('')
        expect(rowNames(target)[0]).toContain('extra.risum')
        expect(newest.getAttribute('aria-pressed')).toBe('true')
        expect(target.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('false')

        search.value = 'extra'
        search.dispatchEvent(new Event('input', { bubbles: true }))
        await settle()
        ;(target.querySelector('nav button') as HTMLButtonElement).click()
        await settle()
        expect(search.value).toBe('')
        expect(rowNames(target)).toHaveLength(4)
        expect(newest.getAttribute('aria-pressed')).toBe('true')
        expect(target.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('false')
    })

    it('resolves null when cancelled', async () => {
        const picked = openProtonBrowser('https://drive.proton.me/urls/T#P', '', ROOT)
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted.push(mount(ProtonFolderBrowser, { target }))
        await tick()

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        expect(await picked).toBeNull()
    })

    // A stray tap beside the window used to cancel and drop the picks
    // (the user's report, 2026-10-28).
    it('stays open with its picks when the backdrop is tapped', async () => {
        const picked = openProtonBrowser('https://drive.proton.me/urls/T#P', '', ROOT)
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted.push(mount(ProtonFolderBrowser, { target }))
        await settle()

        checkboxFor(target, 'card 2.png').click()
        await settle()
        ;(target.querySelector('[data-proton-backdrop]') as HTMLElement).click()
        await settle()

        expect(protonBrowserState.open).toBe(true)
        expect(checkboxFor(target, 'card 2.png').checked).toBe(true)

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        expect(await picked).toBeNull()
    })

    it('shows the server error with a retry', async () => {
        client.inspectProtonShare.mockRejectedValueOnce(new Error('That folder is not inside this share'))
        void openProtonBrowser('https://drive.proton.me/urls/T#P', '', ROOT)
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted.push(mount(ProtonFolderBrowser, { target }))
        await settle()

        ;([...target.querySelectorAll('li button')].find((b) => b.textContent?.includes('Season 2')) as HTMLButtonElement).click()
        await settle()
        expect(target.textContent).toContain('That folder is not inside this share')
    })
})
