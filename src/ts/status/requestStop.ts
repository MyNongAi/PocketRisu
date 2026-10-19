// The request card's x stops its reply as the chat's own stop button does
// (the user's request, 2026-10-18), then the card closes.
import { get } from 'svelte/store'
import { language } from 'src/lang'
import { notifyWarning } from '../alert'
import { chatGenKey, generationStates, stopGeneration } from '../process/generationState'
import { clearPendingSend } from '../process/request/pendingSends'

/**
 * Stop the reply `id` (a generation id) in the chat `chatId`, as the chat's
 * stop button does. Only while it is still that chat's generation; a request
 * of no chat (translation, memory, …) is not stopped here.
 */
export function stopRequestReply(id: string, chatId: string | undefined): boolean {
    if (!chatId) return false
    const key = chatGenKey(chatId)
    if (get(generationStates).get(key)?.generationId !== id) return false
    stopGeneration(key, {
        // As DefaultChatScreen's stop: a send that never wound down is over.
        onForceReleased: (chatKey) => {
            clearPendingSend(chatKey)
            notifyWarning(language.errors.generationForceReleased)
        },
    })
    return true
}
