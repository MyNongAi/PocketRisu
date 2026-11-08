// Putting a deleted message back into its chat (messageUndo.ts).
import { get } from 'svelte/store'
import { language } from 'src/lang'
import { notifyError, notifyInfo, notifySuccess } from 'src/ts/alert'
import { retitleChatFromLastInput } from 'src/ts/chatClone'
import { chatTitleState } from 'src/ts/chatTitleState'
import { DBState } from 'src/ts/stores.svelte'
import type { Message } from 'src/ts/storage/database.svelte'
import { forgetMessageDeletion, messageDeletions, withDeletionRestored, type MessageDeletion } from './messageUndo'

/** Put deletion `id` back; false when it could not be (said in a toast). */
export function undoMessageDeletion(id: number): boolean {
    const deletion = get(messageDeletions).find((entry) => entry.id === id)
    if (!deletion) return false
    const character = DBState.db.characters.find((entry) => entry?.chaId === deletion.chaId)
    const chatIndex = character?.chats?.findIndex((entry) => entry?.id === deletion.chatId) ?? -1
    const chat = chatIndex >= 0 ? character!.chats[chatIndex] : undefined
    if (!character || !chat) {
        forgetMessageDeletion(id)
        notifyError(language.messageUndoGone)
        return false
    }
    // A chat not loaded right now keeps the deletion for later.
    if (chat._placeholder) {
        notifyError(language.messageUndoNotLoaded)
        return false
    }
    const { messages, restored } = withDeletionRestored(chat.message, deletion as MessageDeletion<Message>)
    forgetMessageDeletion(id)
    if (restored === 0) {
        notifyInfo(language.messageUndoAlready)
        return false
    }
    chat.message = messages
    // The title follows the last input (chatClone.ts), unless the user typed one.
    if (chatTitleState(character, chat.id) === 'auto') retitleChatFromLastInput(character.chats, chatIndex)
    notifySuccess(language.messageUndoDone.replace('{}', String(restored)))
    return true
}
