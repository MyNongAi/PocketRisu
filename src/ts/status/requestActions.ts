// The request card's arrow (the user's request, 2026-10-18): it opens the
// chat the reply is being written in. Its x stops the reply (requestStop.ts).
import { changeChar } from '../characters'
import { changeChatTo } from '../globalApi.svelte'
import { DBState, selIdState } from '../stores.svelte'

/** Open the chat `chatId`, switching to its character when another one is open. */
export function openChatById(chatId: string | undefined): void {
    if (!chatId) return
    const characters = DBState.db.characters ?? []
    const characterIndex = characters.findIndex((character) => character?.chats?.some((chat) => chat?.id === chatId))
    if (characterIndex < 0) return
    if (characterIndex === selIdState.selId) {
        changeChatTo(chatId)
        return
    }
    // Open the character on that chat directly.
    const character = characters[characterIndex]
    const chatIndex = character.chats.findIndex((chat) => chat?.id === chatId)
    if (chatIndex >= 0) character.chatPage = chatIndex
    changeChar(characterIndex)
}
