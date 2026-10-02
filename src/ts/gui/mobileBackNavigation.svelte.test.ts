import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { flushSync } from 'svelte'
import { get, writable } from 'svelte/store'

vi.mock('../characterCards', () => ({ showRealmInfoStore: writable(null) }))
vi.mock('../assetViewer.svelte', () => ({ assetViewerStore: { open: false }, closeAssetViewer: vi.fn() }))
vi.mock('../protonBrowser.svelte', () => ({ protonBrowserState: { open: false }, closeProtonBrowser: vi.fn() }))

const stores = await import('../stores.svelte')
const { createBackLayerStack } = await import('./backLayers.svelte')
const { registerStoreLayers } = await import('./mobileBackNavigation.svelte')

const {
    alertMinimizedStore, alertStore, DynamicGUI, MobileGUI,MobileGUIStack, MobileSideBar, openCharacterManager, openPersonaList,
    personaSelectCallback, selectedCharID, SettingsMenuIndex, settingsOpen, sideBarClosing, sideBarStore,
} = stores

let stack: ReturnType<typeof createBackLayerStack>
let stop: () => void
let wideSettings = true

function back() {
    const result = stack.dismissTop()
    flushSync()
    return result
}

beforeEach(() => {
    wideSettings = true
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({ matches: wideSettings, media: query }) as MediaQueryList)
    stack = createBackLayerStack()
    stop = $effect.root(() => registerStoreLayers(stack))
    flushSync()
})

afterEach(() => {
    stop()
    vi.restoreAllMocks()
    alertStore.set({ type: 'none', msg: '' })
    alertMinimizedStore.set(false)
    settingsOpen.set(false)
    openPersonaList.set(false)
    personaSelectCallback.set(null)
    openCharacterManager.set(false)
    sideBarStore.set(false)
    sideBarClosing.set(false)
    DynamicGUI.set(false)
    MobileGUI.set(false)
    MobileGUIStack.set(0)
    MobileSideBar.set(0)
    selectedCharID.set(-1)
    SettingsMenuIndex.set(-1)
})

describe('mobile Back over the app layers', () => {
    test('closes alert, popup, settings, then the overlay sidebar', () => {
        DynamicGUI.set(true)
        sideBarStore.set(true)
        settingsOpen.set(true)
        openPersonaList.set(true)
        personaSelectCallback.set(() => {})
        alertStore.set({ type: 'ask', msg: 'Delete?' })
        flushSync()

        expect(back()).toBe('closed')
        expect(get(alertStore)).toEqual({ type: 'none', msg: 'no' })
        expect(get(openPersonaList)).toBe(true)

        expect(back()).toBe('closed')
        expect(get(openPersonaList)).toBe(false)
        expect(get(personaSelectCallback)).toBeNull()
        expect(get(settingsOpen)).toBe(true)

        expect(back()).toBe('closed')
        expect(get(settingsOpen)).toBe(false)

        expect(back()).toBe('closed')
        expect(get(sideBarClosing)).toBe(true)
        expect(stack.hasOpen()).toBe(false)
        expect(back()).toBe('none')
    })

    test('a question tucked into its round button is left unanswered; Back goes to the app', () => {
        settingsOpen.set(true)
        alertStore.set({ type: 'ask', msg: 'Allow low-level access?' })
        alertMinimizedStore.set(true)
        flushSync()

        expect(back()).toBe('closed')
        expect(get(settingsOpen)).toBe(false)
        expect(get(alertStore)).toEqual({ type: 'ask', msg: 'Allow low-level access?' })
    })

    test('a picker alert or a loading alert is not dismissed', () => {
        for (const type of ['select', 'wait'] as const) {
            alertStore.set({ type, msg: '0||1' })
            flushSync()
            expect(back()).toBe('blocked')
            expect(get(alertStore).type).toBe(type)
        }
    })

    test('a narrow settings page steps back to the menu first', () => {
        wideSettings = false
        settingsOpen.set(true)
        SettingsMenuIndex.set(3)
        flushSync()

        expect(back()).toBe('closed')
        expect(get(SettingsMenuIndex)).toBe(-1)
        expect(get(settingsOpen)).toBe(true)

        expect(back()).toBe('closed')
        expect(get(settingsOpen)).toBe(false)
    })

    test('layers hidden behind the settings page or a docked sidebar do not count', () => {
        openCharacterManager.set(true)
        settingsOpen.set(true)
        sideBarStore.set(true)
        // DynamicGUI false: the sidebar is docked, not an overlay.
        flushSync()

        expect(back()).toBe('closed')
        expect(get(settingsOpen)).toBe(false)
        expect(back()).toBe('closed')
        expect(get(openCharacterManager)).toBe(false)
        expect(stack.hasOpen()).toBe(false)
        expect(get(sideBarStore)).toBe(true)
    })

    test('mobile GUI side panels close back to the chat', () => {
        MobileGUI.set(true)
        selectedCharID.set(0)
        MobileSideBar.set(2)
        flushSync()

        expect(back()).toBe('closed')
        expect(get(MobileSideBar)).toBe(0)
        expect(stack.hasOpen()).toBe(false)
    })
})
