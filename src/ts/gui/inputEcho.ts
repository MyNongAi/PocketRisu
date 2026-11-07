// The input echo: under each reply, a small copy of the user message it
// answers. Editing either the copy or the original shows every keystroke in
// both places; the text is written to the chat once, when the edit closes.
import { writable } from 'svelte/store'
import { isTypedInput } from '../typedInput'

export type InputEchoDraft = {
    /** The user message being edited (see inputEchoKey). */
    key: string
    text: string
}

export const inputEchoDraft = writable<InputEchoDraft | null>(null)

/**
 * The user message whose own edit should open (its key): the copy under a
 * reply that is still being written hands its edit to the original, because
 * that reply is redrawn while it streams and the redraw closed the edit (the
 * user's report, 2026-10-26).
 */
export const inputEditRequest = writable<string | null>(null)

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

/**
 * The input shown under the reply at `index`: its input (previousInputIndex)
 * when the user sent it from the input box, else none. A bot's own request
 * message ("[ACADEMY_REQUEST:...]", added by its script) showed there as if
 * the user had written it (the user's request, 2026-11-07, typedInput.ts).
 */
export function echoedInputIndex(messages: readonly ((EchoMessage & { data?: string, time?: number }) | undefined)[], index: number): number {
    const input = previousInputIndex(messages, index)
    return input >= 0 && isTypedInput(messages[input]) ? input : -1
}

/** The reply that answers the user message at `index`: the next message that is not a comment, if it is the character's. */
export function nextReplyIndex(messages: readonly (EchoMessage | undefined)[], index: number): number {
    for (let i = index + 1; i < messages.length; i++) {
        const message = messages[i]
        if (!message || message.isComment) continue
        return message.role === 'char' ? i : -1
    }
    return -1
}
