// A chat copied while it is answering (the user's request, 2026-10-17): the
// copy is taken at once and holds everything up to the last finished output,
// without the reply being written. A reroll's old reply, which stays on screen
// until the new one shows text (rerollPlaceholder.ts) but is out of the chat
// meanwhile, goes back in its place. (Before, the copy waited for the reply
// and then held the new one.)
//
// The chat saved while a reply is rerolled is built the same way (the user's
// request, 2026-10-19): the old reply and the comments after it, which the
// reroll took out, are saved in place, so closing the app mid-reroll loses
// none of its pages.

import { restoreScriptstateSnapshot, restoreShownSwipeScriptstate, snapshotScriptstate, type CheckpointMessage, type ScriptstateSnapshot } from './chatScriptstateCheckpoint'

type CopyMessage = { chatId?: string }

export type RerollRestore<M> = {
    index: number
    message: M
    /** Comments and disabled messages after the old reply, out with it. */
    trailing?: readonly M[]
}

export function messagesWithoutPendingReply<M extends CopyMessage>(
    messages: readonly M[],
    pendingGenerationId: string | null | undefined,
    placeholder?: RerollRestore<M> | null,
): M[] {
    // The reply being written carries its generation's id (sendChat).
    const kept = pendingGenerationId ? messages.filter((message) => message.chatId !== pendingGenerationId) : [...messages]
    if (placeholder && placeholder.index >= 0 && placeholder.index <= kept.length) {
        const present = (message: M) => !!message.chatId && kept.some((other) => other.chatId === message.chatId)
        if (present(placeholder.message)) return kept
        const restored = [placeholder.message, ...(placeholder.trailing ?? []).filter((message) => !present(message))]
        kept.splice(placeholder.index, 0, ...restored)
    }
    return kept
}

/** A chat as saved while a reply of it is rerolled (see above). */
export function chatForSave<C extends { message: M[] }, M extends CopyMessage>(
    chat: C,
    pendingGenerationId: string | null | undefined,
    placeholder: RerollRestore<M> | null | undefined,
): C {
    if (!placeholder) return chat
    return { ...chat, message: messagesWithoutPendingReply(chat.message, pendingGenerationId, placeholder) }
}

/**
 * A copy or a branch is not being answered, whatever its source was doing.
 * The streaming flags are set on the source while its reply streams in and
 * are cleared only there, so a snapshot taken meanwhile kept them until its
 * own next reply or a reload: its last reply was drawn as the one being
 * written (no edit button, no tap to edit), and the copy counted as in use
 * and was saved again on every cycle. Mutates and returns `chat`.
 */
export function clearReplyInProgress<C extends { isStreaming?: boolean, activeStreamingDisplayOptimizationMode?: unknown }>(chat: C): C {
    chat.isStreaming = false
    chat.activeStreamingDisplayOptimizationMode = undefined
    return chat
}

// A chat copied while it answers is the chat as it was right before the send
// (the user's choice, 2026-11-08): the input that was sent goes back into the
// copy's input box instead of being a message, and the chat variables are the
// ones from before the send. A bot that marks "waiting for the reply" in its
// variables when a request goes out, and clears it only when the reply comes,
// otherwise left the copy waiting for a reply that never comes there, with its
// input and buttons locked. (Before, the copy kept the sent input and the
// variables as they were at the moment of the copy.)
//
// The composer records where its send began (beginSendTurn). A send the
// composer did not start (a bot's own button, a script) has no such record:
// the copy then ends at the last finished reply, with the variables that reply
// left (its checkpoint, chatScriptstateCheckpoint.ts), when they were recorded.
// A reroll's old reply goes back with the variables it left.

/** The chat right before a send from the composer. */
export type SendTurnStart = {
    /** chatIds of the messages the chat had before the send. */
    ids: ReadonlySet<string>
    /** Its variables then; null when they could not be recorded (too big). */
    scriptstate: ScriptstateSnapshot | null
    /** What the composer held: the copy's input box. */
    input: string
    translate: string
}

const sendTurns = new Map<string, { token: symbol, start: SendTurnStart }>()

type TurnChat = { id?: string, message: { chatId?: string }[], scriptstate?: ScriptstateSnapshot }

/**
 * A send from the composer begins: the chat as it is now. Messages without an
 * id get one (sending gives every message one a moment later anyway). Returns
 * the call that ends the record, when the send is over.
 */
export function beginSendTurn(chat: TurnChat, input: string, translate: string, newId: () => string): () => void {
    for (const message of chat.message) message.chatId ??= newId()
    const start: SendTurnStart = {
        ids: new Set(chat.message.map((message) => message.chatId!)),
        scriptstate: snapshotScriptstate(chat.scriptstate),
        input,
        translate,
    }
    const chatId = chat.id
    if (!chatId) return () => {}
    const token = Symbol('send-turn')
    sendTurns.set(chatId, { token, start })
    return () => {
        if (sendTurns.get(chatId)?.token === token) sendTurns.delete(chatId)
    }
}

export function sendTurnOf(chatId: string): SendTurnStart | undefined {
    return sendTurns.get(chatId)?.start
}

type TurnMessage = CopyMessage & CheckpointMessage & { role?: string }

/**
 * Turn a copy (a detached snapshot of a chat that is answering) into the chat
 * before its send, in place. Returns what goes into the copy's input box, or
 * null to keep the usual draft copy (copyChatDraft).
 */
export function chatAsBeforeSend<M extends TurnMessage>(
    copy: { message: M[], scriptstate?: ScriptstateSnapshot },
    state: { pendingGenerationId?: string | null, placeholder?: RerollRestore<M> | null, turn?: SendTurnStart | null },
): { input: string, translate: string } | null {
    const { pendingGenerationId, placeholder, turn } = state
    // The composer's send: unless its reply is already in (written, and the
    // send only finishing up), the chat as it was before it.
    const replied = !pendingGenerationId && !!turn
        && copy.message.some((message) => message.role === 'char' && !!message.chatId && !turn.ids.has(message.chatId))
    if (turn && !replied) {
        copy.message = copy.message.filter((message) => !!message.chatId && turn.ids.has(message.chatId))
        if (turn.scriptstate) restoreScriptstateSnapshot(copy, turn.scriptstate)
        return turn.input || turn.translate ? { input: turn.input, translate: turn.translate } : null
    }
    if (!pendingGenerationId && !placeholder) return null
    const kept = messagesWithoutPendingReply(copy.message, pendingGenerationId, placeholder)
    if (placeholder) {
        // The old reply is back: so are the variables it left.
        const restored = kept.find((message) => message.chatId === placeholder.message.chatId)
        copy.message = kept
        if (restored) restoreShownSwipeScriptstate(copy, restored)
        return null
    }
    // Another send (a bot's button, a script): up to the last finished reply,
    // when the variables it left were recorded; else as before.
    const last = kept.findLastIndex((message) => message.role === 'char')
    const holder: { scriptstate?: ScriptstateSnapshot } = {}
    if (last >= 0 && last < kept.length - 1 && restoreShownSwipeScriptstate(holder, kept[last])) {
        copy.message = kept.slice(0, last + 1)
        copy.scriptstate = holder.scriptstate
        return null
    }
    copy.message = kept
    return null
}
