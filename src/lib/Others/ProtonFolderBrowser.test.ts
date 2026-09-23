// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import type { ProtonEntry, ProtonInspectResult } from 'src/ts/protonShareClient'

const client = vi.hoisted(() => ({
    inspectProtonShare: vi.fn(),
    fetchProtonThumbnails: vi.fn(async () => {}),
}))
vi.mock('src/ts/protonShareClient', () => client)

import ProtonFolderBrowser from './ProtonFolderBrowser.svelte'
import { buildProtonRows, formatProtonSize, openProtonBrowser, protonBrowserState } from 'src/ts/protonBrowser.svelte'

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
        file('f2', 'card 2.png', { hasThumbnail: true }),
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

    it('formats sizes compactly', () => {
        expect(formatProtonSize(null)).toBe('')
        expect(formatProtonSize(900)).toBe('900 B')
        expect(formatProtonSize(2048)).toBe('2 KB')
        expect(formatProtonSize(39_330_882)).toBe('37.5 MB')
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

        const importButton = [...target.querySelectorAll('button')].find((b) => /\(2\)/.test(b.textContent ?? '')) as HTMLButtonElement
        expect(importButton).toBeTruthy()
        importButton.click()

        const picks = await picked
        expect(picks?.map((pick) => [pick.entry.linkId, pick.path])).toEqual([
            ['f2', []],
            ['s1', ['d1']],
        ])
        expect(protonBrowserState.open).toBe(false)
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
