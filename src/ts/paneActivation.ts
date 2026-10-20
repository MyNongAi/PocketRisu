// Moving the app's selection between the two panes of the split screen
// (chatPanes.svelte.ts). Touching a pane makes it the active one before the
// touch's own action runs (a pointerdown or focus inside it), so the action
// reads the chat that pane shows.

import { get } from 'svelte/store'
import { botMakerMode, chatDeselected, QuickSettings, selectedCharID } from './stores.svelte'
import { applyToggleValues, getDatabase, loadTogglesFromChat, snapshotToggleValues, type Chat } from './storage/database.svelte'
import { ensureChatHydrated } from './storage/chatStorage'
import { locateChat, paneState, paneToggles, persistPanes, selectedChatIds, type PaneChatIds, type PaneId } from './chatPanes.svelte'
import { persistSplitLayout, splitLayout, type PanelTab } from './splitLayout.svelte'

// The character panel's tab lives in app-wide state (botMakerMode, QuickSettings);
// each pane's panel keeps its own, so it is handed over with the selection.
function globalPanelTab(): PanelTab {
    if (QuickSettings?.open) return 'module'
    return get(botMakerMode) ? 'character' : 'chat'
}

function showPanelTab(tab: PanelTab): void {
    if (QuickSettings) QuickSettings.open = tab === 'module'
    botMakerMode.set(tab === 'character')
}

/**
 * Before the selection leaves a pane: its chat's toggle values stay with the
 * pane (paneToggles), and its panel's tab. Toggle binding off keeps toggles
 * app-wide, as the user chose.
 */
function handOver(from: PaneId): void {
    const chatId = selectedChatIds()?.chatId
    if (chatId && !getDatabase().disableToggleBinding) paneToggles[chatId] = snapshotToggleValues()
    splitLayout.tab[from] = globalPanelTab()
    persistSplitLayout()
}

/** A chat's toggles when its pane takes the selection: its pin, then what the pane kept. */
function applyChatToggles(chat: Chat): void {
    loadTogglesFromChat(chat)
    const kept = chat.id ? paneToggles[chat.id] : undefined
    if (kept && !getDatabase().disableToggleBinding) applyToggleValues({ ...kept })
}

/**
 * Select a chat for the active pane. Lighter than changeChar on purpose: no
 * bot-list reorder (recordCurrentCharacterDeparture) and no lastInteraction
 * stamp, which would shuffle the list and the auto-deactivation clock each
 * time the user moves between panes.
 */
function selectChat(characterIndex: number, chatIndex: number): void {
    const db = getDatabase()
    const char = db.characters[characterIndex]
    if (!char) return
    if (char.chatPage !== chatIndex) char.chatPage = chatIndex
    chatDeselected.set(false)
    if (get(selectedCharID) !== characterIndex) selectedCharID.set(characterIndex)
    try {
        if (char.chaId) localStorage.setItem('risu-last-active-character', char.chaId)
    } catch {
        // best effort
    }
    const chat = char.chats?.[chatIndex]
    if (!chat) return
    if (chat._placeholder) {
        void ensureChatHydrated(char.chats, chatIndex, char.chaId).then((hydrated) => {
            if (hydrated && selectedChatIds()?.chatId === hydrated.id) applyChatToggles(hydrated)
        })
    } else {
        applyChatToggles(chat)
    }
}

/**
 * Make `pane` the active one. An empty pane takes the selection with no chat
 * in it; the sidebar then opens a bot or chat there.
 */
export function activatePane(pane: PaneId): boolean {
    if (paneState.active === pane) return false
    const target = locateChat(getDatabase().characters ?? [], paneState.held[pane])
    handOver(paneState.active)
    paneState.held[paneState.active] = selectedChatIds()
    paneState.active = pane
    if (target) selectChat(target.characterIndex, target.chatIndex)
    else selectedCharID.set(-1)
    showPanelTab(splitLayout.tab[pane])
    persistPanes()
    return true
}

/** The divider's "swap": the two panes trade chats; the touched pane stays the active one. */
export function swapPanes(): void {
    const active = paneState.active
    handOver(active)
    paneState.held[active] = selectedChatIds()
    const { main, side } = paneState.held
    paneState.held = { main: side, side: main }
    const target = locateChat(getDatabase().characters ?? [], paneState.held[active])
    if (target) selectChat(target.characterIndex, target.chatIndex)
    else selectedCharID.set(-1)
    persistPanes()
}

/** Show a chat in the side pane (a chat dropped on it). */
export function showInSidePane(ids: PaneChatIds): boolean {
    const target = locateChat(getDatabase().characters ?? [], ids)
    if (!target) return false
    paneState.held.side = ids
    if (paneState.active === 'side') selectChat(target.characterIndex, target.chatIndex)
    else {
        const char = getDatabase().characters[target.characterIndex]
        if (char?.chats?.[target.chatIndex]?._placeholder) void ensureChatHydrated(char.chats, target.chatIndex, char.chaId)
    }
    persistPanes()
    return true
}

/** Before the split closes: the main pane takes the selection back. */
export function returnToMainPane(): void {
    if (paneState.active === 'main') return
    activatePane('main')
}

/** At boot with the split closed: whatever was saved, the main pane is the active one. */
export function settlePanesForClosedSplit(): void {
    if (paneState.active === 'main') return
    paneState.active = 'main'
    persistPanes()
}

/**
 * After a reload with the split open: when boot selected nothing, the active
 * pane gets its chat back (the other pane draws its own by id anyway).
 */
export function restorePanesAfterBoot(): void {
    if (get(selectedCharID) >= 0) return
    const target = locateChat(getDatabase().characters ?? [], paneState.held[paneState.active])
    if (target) selectChat(target.characterIndex, target.chatIndex)
}
