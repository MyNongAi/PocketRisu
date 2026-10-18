// The request card's ">" (the user's request, 2026-10-19; it replaced the
// x): it opens the chat the reply is being written in, or, on that chat
// already, scrolls it to the end where the reply is.
import { changeChar } from '../characters'
import { changeChatTo } from '../globalApi.svelte'
import { DBState, selIdState } from '../stores.svelte'

/** DefaultChatScreen scrolls the chat on screen to its end on this event. */
export const SCROLL_CHAT_TO_END_EVENT = 'pocketrisu:scroll-chat-to-end'

/** Open the chat `chatId`, switching to its character when another one is open. */
export function openChatById(chatId: string | undefined): void {
    if (!chatId) return
    const characters = DBState.db.characters ?? []
    const characterIndex = characters.findIndex((character) => character?.chats?.some((chat) => chat?.id === chatId))
    if (characterIndex < 0) return
    if (characterIndex === selIdState.selId) {
        const character = characters[characterIndex]
        if (character.chats[character.chatPage]?.id === chatId) window.dispatchEvent(new Event(SCROLL_CHAT_TO_END_EVENT))
        else changeChatTo(chatId)
        return
    }
    // Open the character on that chat directly.
    const character = characters[characterIndex]
    const chatIndex = character.chats.findIndex((chat) => chat?.id === chatId)
    if (chatIndex >= 0) character.chatPage = chatIndex
    changeChar(characterIndex)
}
