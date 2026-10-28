import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'

const stores = vi.hoisted(() => ({ quick: { open: false, index: 0 } }))

vi.mock('../stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return {
        DBState: { db: { characters: [], modules: [] } },
        QuickSettings: stores.quick,
        settingsOpen: writable(true),
        sideBarStore: writable(false),
    }
})
vi.mock('../../lang', () => ({ language: {} }))
vi.mock('../alert', () => ({ alertSelect: vi.fn() }))
vi.mock('../characterArchive', () => ({ promptActivateCharacter: vi.fn() }))
vi.mock('../characters', () => ({ changeChar: vi.fn() }))
vi.mock('../routing', () => ({ openSettings: vi.fn(), SettingsRoute: { Module: 'module' } }))
vi.mock('./pairedModules', () => ({ botsOfModule: () => [], modulesOfBot: () => [] }))

void writable
const { addModulePanelFinder, findInSidebar } = await import('./pairFinder')
const { QuickSettings, settingsOpen, sideBarStore } = await import('../stores.svelte')
const now = () => Promise.resolve()

beforeEach(() => {
    QuickSettings.open = false
    QuickSettings.index = 0
    settingsOpen.set(true)
    sideBarStore.set(false)
})

describe("a bot menu's module find", () => {
    it('takes the sidebar list on screen as it is', async () => {
        const remove = addModulePanelFinder((id) => id === 'm1')
        expect(await findInSidebar('m1', now)).toBe(true)
        expect(QuickSettings.open).toBe(false)
        remove()
    })

    it('opens the sidebar on its module tab and waits for the list to take it', async () => {
        let mounted = false
        const remove = addModulePanelFinder(() => mounted)
        const wait = async () => { mounted = QuickSettings.open }
        expect(await findInSidebar('m1', wait)).toBe(true)
        expect(QuickSettings).toMatchObject({ open: true, index: 2 })
        expect(get(sideBarStore)).toBe(true)
        expect(get(settingsOpen)).toBe(false)
        remove()
    })

    it('gives up when the list keeps declining (an open module editor)', async () => {
        const remove = addModulePanelFinder(() => false)
        const wait = vi.fn(now)
        expect(await findInSidebar('m1', wait)).toBe(false)
        expect(wait).toHaveBeenCalledTimes(60)
        remove()
    })
})
