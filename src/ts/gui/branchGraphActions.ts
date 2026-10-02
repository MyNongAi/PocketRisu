// What a click on a branch graph node does: open the chat it belongs to and
// scroll to the message, or show one of a reply's swipes. Showing a swipe goes
// through the same steps as the swipe arrows (DefaultChatScreen.switchSwipe):
// refused while the chat is generating, and for the newest reply the chat
// variables that swipe left are restored.

import { tick } from 'svelte'
import { get } from 'svelte/store'
import { language } from 'src/lang'
import { DBState, MobileSideBar, ScrollToMessageStore, selIdState } from '../stores.svelte'
import { changeChatTo } from '../globalApi.svelte'
import { ensureChatHydrated } from '../storage/chatStorage'
import { chatGenKey, isChatGenerating } from '../process/generationState'
import { findLastReplyIndex, showSwipe } from '../chatSwipes'
import { restoreShownSwipeScriptstate } from '../chatScriptstateCheckpoint'
import { notifyError, notifyWarning } from '../alert'
import { resolveSwipeIndex, type BranchGraphTarget } from './branches'

export async function openBranchGraphTarget(target: BranchGraphTarget): Promise<boolean> {
    const character = DBState.db.characters[selIdState.selId]
    if (!character?.chats) return false
    // Chats move (a new branch is unshifted to the top): find it by id.
    const index = target.chatId
        ? character.chats.findIndex((chat) => chat?.id === target.chatId)
        : target.chatIndex
    if (index < 0 || !character.chats[index]) {
        notifyError(language.branchGraphChatMissing)
        return false
    }
    if (character.chatPage !== index) changeChatTo(index)
    // changeChatTo already started the load; this waits for the same one and
    // reports failures on the chat screen.
    const hydrated = await ensureChatHydrated(character.chats, index, character.chaId)
    if (!hydrated || character.chatPage !== index) return false
    // Read back through the store: the hydrated object itself is not reactive.
    const chat = character.chats[index]
    if (!chat || chat._placeholder) return false

    let messageIndex = target.messageIndex
    if (target.messageId) {
        const found = chat.message.findIndex((message) => message?.chatId === target.messageId)
        if (found !== -1) messageIndex = found
    }

    if (target.swipeIndex !== undefined) {
        const message = chat.message[messageIndex]
        if (isChatGenerating(chatGenKey(chat.id))) {
            notifyWarning(language.branchGraphBusy)
        } else {
            const swipeIndex = resolveSwipeIndex(message?.swipes, target.swipeIndex, target.swipePreview)
            if (message && swipeIndex !== -1 && showSwipe(message, swipeIndex)) {
                if (messageIndex === findLastReplyIndex(chat.message)) restoreShownSwipeScriptstate(chat, message)
                character.reloadKeys = (character.reloadKeys ?? 0) + 1
            } else {
                notifyWarning(language.branchGraphSwipeMissing)
            }
        }
    }

    // On the phone layout the chat list replaces the chat screen: go back to it.
    if (get(MobileSideBar) > 0) MobileSideBar.set(0)
    if (messageIndex >= 0 && messageIndex < chat.message.length) {
        await tick()
        ScrollToMessageStore.value = messageIndex
    }
    return true
}
