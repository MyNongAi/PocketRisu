import { get } from 'svelte/store'
import { getCurrentChat } from '../storage/database.svelte'
import { ReloadChatPointer, ReloadGUIPointer } from '../stores.svelte'

// A trigger or script asks to redraw its chat (Lua reloadDisplay /
// reloadChat, v2UpdateGUI / v2UpdateChatAt, a trigger that changed chat
// variables). The redraw signals are global, so a reply finishing in another
// chat of the same bot (a status-panel bot such as Project Echo calls
// reloadDisplay on every output) re-rendered the chat on screen instead, and
// its panels redrew from that chat's state and moved the reader's scroll
// (the user's report, 2026-10-07). Only the chat on screen is redrawn now.

/** Whether `chat` is the chat on screen. A chat without an id (legacy) counts, as before. */
export function isChatOnScreen(chat: { id?: string } | null | undefined, current: { id?: string } | null | undefined = getCurrentChat()): boolean {
    if (!chat || !chat.id) return true
    return chat === current || chat.id === current?.id
}

/** Redraw every message of `chat`, when it is the chat on screen. */
export function reloadChatDisplay(chat: { id?: string } | null | undefined): void {
    if (!isChatOnScreen(chat)) return
    ReloadGUIPointer.set(get(ReloadGUIPointer) + 1)
}

/** Redraw message `index` of `chat`, when it is the chat on screen. */
export function reloadChatMessage(chat: { id?: string } | null | undefined, index: number | string): void {
    // A v2 trigger stores the index as text; the pointers are keyed by number.
    const key = Number(index)
    if (!Number.isFinite(key) || !isChatOnScreen(chat)) return
    ReloadChatPointer.update((pointers) => {
        pointers[key] = (pointers[key] ?? 0) + 1
        return pointers
    })
}
