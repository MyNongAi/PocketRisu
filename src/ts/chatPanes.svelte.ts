// Split screen in one app (the user's report, 2026-10-20): the right pane was
// the whole app again in an iframe, so one tab held the database twice and
// crashed to a white page. Both panes of SplitWorkspace are now ChatScreens of
// this app. The pane the user last touched is the active one and holds the
// app's selection (selectedCharID and that character's chatPage), so every
// action, script, toggle and send that reads "the current chat" acts on what
// it shows, as before. The other pane keeps its chat by id and draws it from
// there; touching it makes it the active one (paneActivation.ts).

import { getContext, setContext, untrack } from 'svelte'
import { DBState, selIdState } from './stores.svelte'
import type { character, Chat } from './storage/database.svelte'

export type PaneId = 'main' | 'side'

export interface PaneChatIds {
    chaId: string
    chatId: string
}

/** What a pane shows, read reactively. */
export interface PaneView {
    readonly pane: PaneId
    /** The pane holds the app's selection. */
    readonly active: boolean
    readonly characterIndex: number
    readonly character: character | undefined
    readonly chatIndex: number
    readonly chat: Chat | undefined
}

const SIDE_KEY = 'pocketrisu:split-chat:side'
const MAIN_KEY = 'pocketrisu:split-chat:main'
const ACTIVE_KEY = 'pocketrisu:split-chat:active'

function readIds(key: string): PaneChatIds | null {
    try {
        const value = JSON.parse(localStorage.getItem(key) ?? 'null')
        return value && typeof value.chaId === 'string' && typeof value.chatId === 'string' ? { chaId: value.chaId, chatId: value.chatId } : null
    } catch {
        return null
    }
}

function writeIds(key: string, ids: PaneChatIds | null): void {
    try {
        if (ids) localStorage.setItem(key, JSON.stringify(ids))
        else localStorage.removeItem(key)
    } catch {
        // best effort
    }
}

function readActive(): PaneId {
    try {
        return localStorage.getItem(ACTIVE_KEY) === 'side' ? 'side' : 'main'
    } catch {
        return 'main'
    }
}

/**
 * held[pane]: the chat a pane shows while it is not the active one. The active
 * pane shows the app's selection instead; its held entry is written when it
 * hands the selection over.
 */
export const paneState = $state({
    active: readActive() as PaneId,
    held: { main: readIds(MAIN_KEY), side: readIds(SIDE_KEY) } as Record<PaneId, PaneChatIds | null>,
})

const TOGGLES_KEY = 'pocketrisu:split-chat:toggles'

function readToggles(): Record<string, Record<string, string>> {
    try {
        const value = JSON.parse(localStorage.getItem(TOGGLES_KEY) ?? 'null')
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch {
        return {}
    }
}

/**
 * Each pane's toggle values by chat id (the user's request, 2026-10-21: a
 * toggle switched in one pane changed the other). Toggles are app-wide state;
 * the pane that hands the selection over keeps its values here, and gets
 * them back when touched again; the other pane draws with them meanwhile
 * (getGlobalChatVar's scope). Kept apart from a chat's own pin
 * (savedToggleValues), which stays the user's to set.
 */
export const paneToggles = $state<Record<string, Record<string, string>>>(readToggles())

export function persistPanes(): void {
    writeIds(MAIN_KEY, paneState.held.main)
    writeIds(SIDE_KEY, paneState.held.side)
    // Only the chats the panes hold.
    const held = new Set([paneState.held.main?.chatId, paneState.held.side?.chatId].filter(Boolean))
    for (const chatId of Object.keys(paneToggles)) {
        if (!held.has(chatId)) delete paneToggles[chatId]
    }
    try {
        localStorage.setItem(ACTIVE_KEY, paneState.active)
        localStorage.setItem(TOGGLES_KEY, JSON.stringify(paneToggles))
    } catch {
        // best effort
    }
}

/** Where the chat with these ids is now, or null. */
export function locateChat(characters: readonly ({ chaId?: string, chats?: readonly ({ id?: string } | null | undefined)[] } | null | undefined)[], ids: PaneChatIds | null): { characterIndex: number, chatIndex: number } | null {
    if (!ids) return null
    const characterIndex = characters.findIndex((c) => c?.chaId === ids.chaId)
    if (characterIndex < 0) return null
    const chatIndex = characters[characterIndex]?.chats?.findIndex((c) => c?.id === ids.chatId) ?? -1
    return chatIndex < 0 ? null : { characterIndex, chatIndex }
}

/** The ids of the chat the app has selected, or null. */
export function selectedChatIds(): PaneChatIds | null {
    const char = DBState.db?.characters?.[selIdState.selId]
    const chat = char?.chats?.[char.chatPage]
    return char?.chaId && chat?.id ? { chaId: char.chaId, chatId: chat.id } : null
}

/** A reactive view of what `pane` shows. */
export function paneView(pane: PaneId): PaneView {
    return {
        pane,
        get active() {
            return paneState.active === pane
        },
        get characterIndex() {
            if (paneState.active === pane) return selIdState.selId
            return locateChat(DBState.db?.characters ?? [], paneState.held[pane])?.characterIndex ?? -1
        },
        get character() {
            return DBState.db?.characters?.[this.characterIndex]
        },
        get chatIndex() {
            if (paneState.active === pane) return this.character?.chatPage ?? -1
            return locateChat(DBState.db?.characters ?? [], paneState.held[pane])?.chatIndex ?? -1
        },
        get chat() {
            const index = this.chatIndex
            return index >= 0 ? this.character?.chats?.[index] : undefined
        },
    }
}

/** The main pane, what every chat screen showed before the split. */
export const mainPaneView = paneView('main')
export const sidePaneView = paneView('side')

/**
 * Chats shown on screen other than the selected one (the pane that is not
 * active): their edits and replies must be saved and their bodies kept loaded
 * (globalApi save watchers, chatStorage eviction).
 */
export function chatsShownBesideSelection(splitOpen: boolean): PaneChatIds[] {
    if (!splitOpen) return []
    const inactive: PaneId = paneState.active === 'main' ? 'side' : 'main'
    const ids = paneState.held[inactive]
    const selected = selectedChatIds()
    if (!ids || (selected && selected.chaId === ids.chaId && selected.chatId === ids.chatId)) return []
    return [ids]
}

const PANE_CONTEXT = Symbol('chat-pane')

/** Set by a ChatScreen for everything drawn inside it. */
export function setPaneContext(view: PaneView): void {
    setContext(PANE_CONTEXT, view)
}

/** The pane this component is drawn in; the main pane outside a ChatScreen. */
export function getPaneView(): PaneView {
    return getContext<PaneView | undefined>(PANE_CONTEXT) ?? mainPaneView
}

/**
 * Keeps the active pane's held chat in step with the selection, so it is
 * saved with the panes and comes back after a reload (the selection itself
 * is restored at boot only with "restore the last chat" on).
 */
export function startPaneSync(): () => void {
    return $effect.root(() => {
        $effect(() => {
            const ids = selectedChatIds()
            if (!ids) return
            untrack(() => {
                const held = paneState.held[paneState.active]
                if (held?.chaId === ids.chaId && held.chatId === ids.chatId) return
                paneState.held[paneState.active] = ids
                persistPanes()
            })
        })
    })
}
