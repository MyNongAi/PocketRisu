// Moving the app's selection between the two panes of the split screen
// (chatPanes.svelte.ts). Touching a pane makes it the active one before the
// touch's own action runs (a pointerdown or focus inside it), so the action
// reads the chat that pane shows.

import { get } from 'svelte/store'
import { chatDeselected, selectedCharID } from './stores.svelte'
import { getDatabase, loadTogglesFromChat } from './storage/database.svelte'
import { ensureChatHydrated } from './storage/chatStorage'
import { locateChat, paneState, persistPanes, selectedChatIds, type PaneChatIds, type PaneId } from './chatPanes.svelte'

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
            if (hydrated && selectedChatIds()?.chatId === hydrated.id) loadTogglesFromChat(hydrated)
        })
    } else {
        loadTogglesFromChat(chat)
    }
}

/**
 * Make `pane` the active one. An empty pane takes the selection with no chat
 * in it; the sidebar then opens a bot or chat there.
 */
export function activatePane(pane: PaneId): boolean {
    if (paneState.active === pane) return false
    const target = locateChat(getDatabase().characters ?? [], paneState.held[pane])
    paneState.held[paneState.active] = selectedChatIds()
    paneState.active = pane
    if (target) selectChat(target.characterIndex, target.chatIndex)
    else selectedCharID.set(-1)
    persistPanes()
    return true
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
