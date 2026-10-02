// Mobile Back closes the topmost open layer before it may leave the page.
// The layers drawn from global stores are registered here, in the order they
// close (BackLayerRank); component-local ones register themselves with
// useBackLayer (ShDialog, the chat and module lists, ...). Desktop keeps the
// browser's own Back.

import { tick } from 'svelte'
import { fromStore, get } from 'svelte/store'
import { v4 as uuidv4 } from 'uuid'
import { alertStore, bookmarkListOpen, DynamicGUI, hypaV3ModalOpen, memoryPresetSelectCallback, MobileGUI, MobileGUIStack, MobileSideBar, openCharacterManager, openMemoryPresetList, openModelPresetList, openModelProfileBrowser, openPersonaList, openPresetList, openThemePresetList, personaSelectCallback, pluginAlertModalStore, popupStore, popUpEditorStore, selectedCharID, SettingsMenuIndex, settingsOpen, sideBarClosing, sideBarStore } from '../stores.svelte'
import { showRealmInfoStore } from '../characterCards'
import { assetViewerStore, closeAssetViewer } from '../assetViewer.svelte'
import { closeProtonBrowser, protonBrowserState } from '../protonBrowser.svelte'
import { isEmbeddedRisuPane } from '../chatSplitPane'
import { isIOS, isMobile } from '../platform'
import { SettingsRoute } from '../routing'
import { alertBackDismissal, backLayers, BackLayerRank, useBackLayer, type BackLayerStack } from './backLayers.svelte'
import { createBackHistoryGuard } from './backHistoryGuard'

// Settings.svelte shows either its menu or one page below this width.
const SETTINGS_SPLIT_QUERY = '(min-width: 700px)'

/** Registers the store-driven layers; call inside $effect.root. */
export function registerStoreLayers(stack: BackLayerStack = backLayers): void {
    const layer = (rank: number, isOpen: () => boolean, close?: () => boolean | void) =>
        useBackLayer(rank, isOpen, close, stack)
    const alert = fromStore(alertStore)
    const settings = fromStore(settingsOpen)
    const mobileGUI = fromStore(MobileGUI)
    const dynamicGUI = fromStore(DynamicGUI)
    const sideBar = fromStore(sideBarStore)
    const sideBarIsClosing = fromStore(sideBarClosing)
    const selectedChar = fromStore(selectedCharID)
    const mobileStack = fromStore(MobileGUIStack)
    const mobileSideBar = fromStore(MobileSideBar)
    const settingsMenu = fromStore(SettingsMenuIndex)
    const characterManager = fromStore(openCharacterManager)
    const realmInfo = fromStore(showRealmInfoStore)

    // Alerts: Back answers the way their cancel / "no" / close control does.
    layer(BackLayerRank.Alert, () => alert.current.type !== 'none', () => {
        const dismissal = alertBackDismissal(get(alertStore))
        if (!dismissal) return false
        alertStore.set(dismissal)
    })
    // Plugin risk warning: Back is "do not install".
    layer(BackLayerRank.Alert, () => pluginAlertModalStore.open, () => {
        pluginAlertModalStore.open = false
    })

    layer(BackLayerRank.Menu, () => popupStore.children !== null, () => {
        popupStore.children = null
    })

    // Popups, closed as App.svelte's close props do.
    const storePopups = [
        openPresetList,
        openModelPresetList,
        openModelProfileBrowser,
        openThemePresetList,
        bookmarkListOpen,
        hypaV3ModalOpen,
    ]
    for (const store of storePopups) {
        const open = fromStore(store)
        layer(BackLayerRank.Popup, () => open.current, () => store.set(false))
    }
    const personaList = fromStore(openPersonaList)
    layer(BackLayerRank.Popup, () => personaList.current, () => {
        openPersonaList.set(false)
        personaSelectCallback.set(null)
    })
    const memoryPresetList = fromStore(openMemoryPresetList)
    layer(BackLayerRank.Popup, () => memoryPresetList.current, () => {
        openMemoryPresetList.set(false)
        memoryPresetSelectCallback.set(null)
    })
    layer(BackLayerRank.Popup, () => realmInfo.current !== null, () => showRealmInfoStore.set(null))
    layer(BackLayerRank.Popup, () => popUpEditorStore.open, () => {
        popUpEditorStore.open = false
    })
    layer(BackLayerRank.Popup, () => assetViewerStore.open, closeAssetViewer)
    layer(BackLayerRank.Popup, () => protonBrowserState.open, () => closeProtonBrowser(null))
    // The overlay character manager is only drawn by the regular shell.
    layer(
        BackLayerRank.Popup,
        () => characterManager.current && !settings.current && !mobileGUI.current,
        () => openCharacterManager.set(false),
    )

    // Settings: on a narrow screen a page first steps back to the menu,
    // like its own close button.
    layer(BackLayerRank.Page, () => settings.current, () => {
        if (!get(MobileGUI) && !window.matchMedia(SETTINGS_SPLIT_QUERY).matches
            && get(SettingsMenuIndex) !== SettingsRoute.None) {
            SettingsMenuIndex.set(SettingsRoute.None)
            return
        }
        settingsOpen.set(false)
    })
    // Mobile GUI settings tab: a page steps back to the menu (header arrow).
    layer(
        BackLayerRank.Page,
        () => mobileGUI.current && !settings.current && selectedChar.current === -1
            && mobileStack.current === 2 && settingsMenu.current > SettingsRoute.None,
        () => SettingsMenuIndex.set(SettingsRoute.None),
    )

    // The overlay sidebar of a narrow shell; a docked one is not a layer.
    layer(
        BackLayerRank.Panel,
        () => sideBar.current && !sideBarIsClosing.current && dynamicGUI.current
            && !settings.current && !mobileGUI.current,
        () => sideBarClosing.set(true),
    )
    // Mobile GUI chat side panels (menu, character, tools).
    layer(
        BackLayerRank.Panel,
        () => mobileGUI.current && !settings.current && selectedChar.current !== -1 && mobileSideBar.current > 0,
        () => MobileSideBar.set(0),
    )
}

let initialized = false

export function initMobileBackNavigation(): void {
    if (initialized) return
    initialized = true
    // Desktop keeps today's Back. An embedded split pane shares the top
    // window's history, so it must not push entries either.
    if (!(isMobile || isIOS()) || isEmbeddedRisuPane || typeof window.history?.pushState !== 'function') return

    $effect.root(() => {
        registerStoreLayers()
    })

    const guard = createBackHistoryGuard({
        history: window.history,
        target: window,
        guardId: uuidv4(),
        hasOpenLayer: () => backLayers.hasOpen(),
        dismissTopLayer: () => { backLayers.dismissTop() },
        settle: () => tick(),
        isUserActive: () => navigator.userActivation?.isActive,
    })
    backLayers.subscribe(guard.requestSync)
}
