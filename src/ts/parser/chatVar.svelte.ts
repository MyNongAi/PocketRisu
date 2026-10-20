import { get } from 'svelte/store'
import { DBState, selectedCharID } from '../stores.svelte'
import { parseKeyValue } from '../util'
import type { character, Chat } from '../storage/database.svelte'

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
    chat.scriptstate ??= {}
    const state = (chat.scriptstate['$' + key])
    if(state === undefined || state === null){
        const defaultVariables = parseKeyValue(char.defaultVariables).concat(parseKeyValue(DBState.db.templateDefaultVariables))
        const findResult = defaultVariables.find((f) => {
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
    chat.scriptstate ??= {}

    const stateKey = '$' + key
    if(chat.scriptstate[stateKey] === value){
        return false
    }

    chat.scriptstate[stateKey] = value
    return true
}

export function getGlobalChatVar(key:string): string {
    return DBState.db.globalChatVariables[key] ?? 'null'
}
