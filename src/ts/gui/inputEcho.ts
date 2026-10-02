// The input echo: under each reply, a small copy of the user message it
// answers. Editing either the copy or the original shows every keystroke in
// both places; the text is written to the chat once, when the edit closes.
import { writable } from 'svelte/store'

export type InputEchoDraft = {
    /** The user message being edited (see inputEchoKey). */
    key: string
    text: string
}

export const inputEchoDraft = writable<InputEchoDraft | null>(null)

type EchoMessage = { role?: string, isComment?: boolean, chatId?: string }

/** A message's identity for the draft: its chat id, else its index. */
export function inputEchoKey(message: EchoMessage | undefined, index: number): string {
    return message?.chatId ? `id:${message.chatId}` : `index:${index}`
}

/**
 * The user message a reply answers: the nearest earlier message that is not a
 * comment, if it is a user message. A reply that follows another reply (a
 * continuation) has none, so one input is echoed once.
 */
export function previousInputIndex(messages: readonly (EchoMessage | undefined)[], index: number): number {
    for (let i = index - 1; i >= 0; i--) {
        const message = messages[i]
        if (!message || message.isComment) continue
        return message.role === 'user' ? i : -1
    }
    return -1
}
