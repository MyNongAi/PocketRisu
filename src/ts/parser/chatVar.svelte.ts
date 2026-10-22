import { get } from 'svelte/store'
import { DBState, selectedCharID } from '../stores.svelte'
import { parseKeyValue } from '../util'
import type { character, Chat } from '../storage/database.svelte'
import { paneToggles, shownBesideSelection } from '../chatPanes.svelte'

/**
 * Whose variables: a parse that names its character and chat (a chat drawn in
 * the split's other pane, chatPanes.svelte.ts; a send's own chat) reads and
 * writes those; otherwise the selected chat, as always.
 */
export interface ChatVarScope {
    chara?: string | character
    chat?: Chat
}

function scopedChat(scope?: ChatVarScope): { char: character | undefined, chat: Chat | undefined } {
    const char = scope?.chara && typeof scope.chara !== 'string'
        ? scope.chara
        : DBState.db.characters[get(selectedCharID)]
    return { char, chat: scope?.chat ?? char?.chats?.[char.chatPage] }
}

export function getChatVar(key:string, scope?: ChatVarScope): string {
    const { char, chat } = scopedChat(scope)
    if(!char || !chat){
        return 'null'
    }
    return getChatVarOf(chat, key, char.defaultVariables)
}

/** getChatVar for a given chat instead of the open one. */
export function getChatVarOf(chat:Chat, key:string, defaultVariables?:string): string {
    // A read writes nothing: {{getvar}} runs inside $derived and {#await}
    // blocks (BackgroundDom, PopupEditor), where creating scriptstate threw
    // state_unsafe_mutation for a chat without one (a stub, a new chat).
    const state = chat.scriptstate?.['$' + key]
    if(state === undefined || state === null){
        const defaults = parseKeyValue(defaultVariables).concat(parseKeyValue(DBState.db.templateDefaultVariables))
        const findResult = defaults.find((f) => {
            return f[0] === key
        })
        if(findResult){
            return findResult[1]
        }
        return 'null'
    }
    return state.toString()
}

export function setChatVar(key:string, value:string, scope?: ChatVarScope): boolean {
    const { chat } = scopedChat(scope)
    if(!chat) return false
    return setChatVarOf(chat, key, value)
}

/** setChatVar for a given chat instead of the open one. */
export function setChatVarOf(chat:Chat, key:string, value:string): boolean {
    chat.scriptstate ??= {}

    const stateKey = '$' + key
    if(chat.scriptstate[stateKey] === value){
        return false
    }

    chat.scriptstate[stateKey] = value
    return true
}

/**
 * A toggle read for the chat drawn in the split's pane beside the selection
 * (its messages, or a reply still being written there) comes from that
 * chat's own values: what its pane kept (paneToggles), else its pin. So each
 * pane draws with its own toggles. Any other chat reads the live values, as
 * before the split, even one left while its reply streams: a pin is only a
 * snapshot the user may not have updated.
 */
export function getGlobalChatVar(key:string, scope?: ChatVarScope): string {
    const chat = scope?.chat
    if (chat?.id && key.startsWith('toggle_') && !DBState.db.disableToggleBinding && shownBesideSelection(chat.id)) {
        const kept = paneToggles[chat.id]
        if (kept) return kept[key] ?? 'null'
        const pin = chat.savedToggleValues
        if (pin && key in pin) return pin[key] ?? 'null'
        if (pin && chat.savedToggleUnsetKeys?.includes(key)) return 'null'
    }
    return DBState.db.globalChatVariables[key] ?? 'null'
}
