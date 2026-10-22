// Moving the app's selection between the two panes of the split screen
// (chatPanes.svelte.ts). Touching a pane makes it the active one before the
// touch's own action runs (a pointerdown or focus inside it), so the action
// reads the chat that pane shows.

import { get } from 'svelte/store'
import { botMakerMode, chatDeselected, QuickSettings, selectedCharID } from './stores.svelte'
import { applyToggleValues, changeToPreset, getDatabase, loadTogglesFromChat, snapshotToggleValues, type Chat } from './storage/database.svelte'
import { ensureChatHydrated } from './storage/chatStorage'
import { locateChat, paneState, paneToggles, persistPanes, pinnedToggleValues, selectedChatIds, type PaneChatIds, type PaneId } from './chatPanes.svelte'
import { persistSplitLayout, splitLayout, type PanelTab } from './splitLayout.svelte'
import { markSeen } from './newMarks.svelte'

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
    const db = getDatabase()
    const ids = selectedChatIds()
    const at = locateChat(db.characters ?? [], ids)
    const chat = at ? db.characters[at.characterIndex]?.chats?.[at.chatIndex] : undefined
    // Still loading after a pane switch: the live values are the previous
    // chat's, and what its pane kept for it stays until it is applied. (After
    // a reload they are this chat's own, and are kept as before.)
    const borrowed = !!chat?._placeholder && borrowedLiveFor === ids?.chatId
    if (ids && chat && !borrowed && !db.disableToggleBinding) paneToggles[ids.chatId] = snapshotToggleValues()
    splitLayout.tab[from] = globalPanelTab()
    persistSplitLayout()
}

/** A chat's toggles when its pane takes the selection: its pin, then what the pane kept. */
function applyChatToggles(chat: Chat, kept: Record<string, string> | undefined): void {
    loadTogglesFromChat(chat)
    if (kept && !getDatabase().disableToggleBinding) applyToggleValues(kept)
}

/**
 * What a pane kept for a chat, taken as the chat takes the selection: from
 * then on its values are the app's live ones, and a copy left behind was laid
 * over them again later (a reload's restore).
 */
function takeKeptToggles(chatId: string | undefined): Record<string, string> | undefined {
    const kept = chatId ? paneToggles[chatId] : undefined
    if (!chatId || !kept) return undefined
    delete paneToggles[chatId]
    return { ...kept }
}

/**
 * A chat put beside the selection keeps the values it would take the
 * selection with from now on, so switches in the active pane leave it alone.
 * Values it already kept stay.
 */
function keepTogglesBeside(chat: Chat | undefined, live: Record<string, string>): void {
    if (!chat?.id || paneToggles[chat.id] || getDatabase().disableToggleBinding) return
    if (selectedChatIds()?.chatId === chat.id) return
    paneToggles[chat.id] = pinnedToggleValues(chat, live)
}

/**
 * Select a chat for the active pane. Lighter than changeChar on purpose: no
 * bot-list reorder (recordCurrentCharacterDeparture) and no lastInteraction
 * stamp, which would shuffle the list and the auto-deactivation clock each
 * time the user moves between panes.
 */
// The latest selectChat: a load that ends after another selection applies nothing.
let selectSerial = 0
// A chat a pane switch selected while still a stub: until its own values are
// applied, the live toggles are the previous chat's.
let borrowedLiveFor: string | null = null

/**
 * The selected chat's binding to a prompt preset, applied before its toggles:
 * the switch lays the chat's pin over the live values (changeToPreset), which
 * covered what its pane had kept when PromptBind applied it afterwards.
 */
function applyBoundPreset(chat: Chat): void {
    const db = getDatabase()
    if (!db.showPresetInSidebar || !chat.bindedBotPreset) return
    const index = db.botPresets?.findIndex((preset) => preset.id === chat.bindedBotPreset) ?? -1
    if (index >= 0 && db.botPresetsId !== index) changeToPreset(index)
}

/** A loaded selected chat's toggles: its pin, then what its pane kept for it. */
export function applySelectedChatToggles(chat: Chat): void {
    if (borrowedLiveFor === chat.id) borrowedLiveFor = null
    applyBoundPreset(chat)
    applyChatToggles(chat, takeKeptToggles(chat.id))
    persistPanes()
}

function selectChat(characterIndex: number, chatIndex: number, ownLiveValues = false): void {
    const db = getDatabase()
    const char = db.characters[characterIndex]
    if (!char) return
    if (char.chatPage !== chatIndex) char.chatPage = chatIndex
    markSeen(char)
    chatDeselected.set(false)
    if (get(selectedCharID) !== characterIndex) selectedCharID.set(characterIndex)
    try {
        if (char.chaId) localStorage.setItem('risu-last-active-character', char.chaId)
    } catch {
        // best effort
    }
    const chat = char.chats?.[chatIndex]
    if (!chat) return
    const serial = ++selectSerial
    if (chat._placeholder) {
        // What the pane kept is taken only as it is applied: a touch back
        // before the chat loads, or a failed load, keeps it (2026-10-22 split
        // review: the previous chat's values were stored under this one).
        borrowedLiveFor = ownLiveValues ? null : chat.id ?? null
        void ensureChatHydrated(char.chats, chatIndex, char.chaId).then((hydrated) => {
            if (!hydrated || serial !== selectSerial || selectedChatIds()?.chatId !== hydrated.id) return
            applySelectedChatToggles(hydrated)
        }).catch(() => { /* the pane shows the load failure and its retry */ })
    } else {
        borrowedLiveFor = null
        applyBoundPreset(chat)
        applyChatToggles(chat, takeKeptToggles(chat.id))
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
        const chat = char?.chats?.[target.chatIndex]
        const live = snapshotToggleValues()
        keepTogglesBeside(chat, live)
        if (chat?._placeholder) {
            // A stub carries no pin; the loaded chat's goes under the same values.
            void ensureChatHydrated(char.chats, target.chatIndex, char.chaId).then((hydrated) => {
                if (!hydrated?.id || !hydrated.savedToggleValues || !paneToggles[hydrated.id]) return
                if (paneState.active !== 'main' || paneState.held.side?.chatId !== hydrated.id) return
                paneToggles[hydrated.id] = pinnedToggleValues(hydrated, live)
                persistPanes()
            }).catch(() => { /* the pane shows the load failure and its retry */ })
        }
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
    const ids = paneState.held[paneState.active]
    const target = locateChat(getDatabase().characters ?? [], ids)
    if (!ids || !target) return
    // The live values loaded with the database are this chat's; anything its
    // pane still kept for it is older.
    delete paneToggles[ids.chatId]
    selectChat(target.characterIndex, target.chatIndex, true)
    persistPanes()
}
