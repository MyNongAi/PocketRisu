// Which user messages are the user's own input (the user's request,
// 2026-11-07: "내가 직접 넣은 인풋만 제목으로", and the same for the input
// shown under a reply). Bots also put user messages in the chat: a panel's
// request ("[ACADEMY_REQUEST:2:1:19] ...", Lua addChat/insertChat or a
// trigger's add-chat), or a context block their Lua appends to what the user
// typed ("[SIM_REQUEST_CONTEXT] ... [/SIM_REQUEST_CONTEXT]").
//
// A message sent from the input box carries its send time; one a script adds
// does not (in the live DB, the untimed user messages were bots' commands and
// records). The empty send ("*says nothing*") has none either.
//
// What the user typed is kept with the message when it is sent, before the
// bot's regex and Lua edit it (the user's request, 2026-11-09: "그냥 구조를
// '내가 직접 쓴 인풋만' 인풋미리보기에 보이거나, 저장하면 되는 거 아니야?").
// Matching a bot's blocks by pattern missed the 명조 bot's one-line
// `[[SIM_HSIN_GATE_INPUT:…]]` marks; the record does not depend on any bot's
// format. Messages sent before the record existed still fall back to the
// pattern.

import { textHash } from './inputVersions'

/** What the user typed, by the hash of the message text it became. */
export type TypedInputRecord = Record<string, string>

type InputMessage = { role?: string, data?: string, time?: number, nodeOnlyTypedInputs?: TypedInputRecord }

/** As many as an input's versions (inputVersions.ts MAX_INPUT_VERSIONS). */
const MAX_TYPED_RECORDS = 20

/** `[UPPER_NAME]...[/UPPER_NAME]` (or `[UPPER_NAME:args]`): a block a bot appends to the input. */
const SYSTEM_BLOCK = /\n?\[([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?::[^\]\n]*)?\][\s\S]*?\[\/\1\]/g

/** The text without the blocks a bot's script adds to an input, as the user typed it. */
export function withoutSystemBlocks(text: string): string {
    return text.replace(SYSTEM_BLOCK, '').trimEnd()
}

/** Remember that the message's current text is what the user typed as `typed`. */
export function rememberTypedInput(message: { data?: string, nodeOnlyTypedInputs?: TypedInputRecord }, typed: string): void {
    if (typeof message.data !== 'string') return
    const key = textHash(message.data)
    const record: TypedInputRecord = { ...(message.nodeOnlyTypedInputs ?? {}) }
    delete record[key]
    record[key] = typed
    const keys = Object.keys(record)
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_TYPED_RECORDS))) delete record[old]
    message.nodeOnlyTypedInputs = record
}

/**
 * What the user typed for the input text `data`: the record for that text;
 * else a recorded typed text found inside it (a bot that appends to the
 * input again later); else, for an input sent before the record existed, the
 * text without HTML comments and a bot's `[NAME]…[/NAME]` blocks.
 */
export function typedText(data: string, record?: TypedInputRecord): string {
    if (record) {
        const exact = record[textHash(data)]
        if (exact !== undefined) return exact
        let found: string | undefined
        for (const typed of Object.values(record)) {
            if (typed && data.includes(typed) && (found === undefined || typed.length > found.length)) found = typed
        }
        if (found !== undefined) return found
    }
    return withoutSystemBlocks(data.replace(/\n?<!--[\s\S]*?-->/g, ''))
}

/** What the user typed for a message's current text (typedText). */
export function typedTextOf(message: InputMessage): string {
    return typedText(message.data ?? '', message.nodeOnlyTypedInputs)
}

/**
 * After an edit replaced `before` with the message's current text: the part
 * the bot added around what was typed (before and after it) is still there,
 * so the text between is what is typed now. Edits that touch the bot's part
 * leave no record, and the input shows by typedText's fallback.
 */
export function carryTypedInput(message: { data?: string, nodeOnlyTypedInputs?: TypedInputRecord }, before: string): void {
    const after = message.data
    const record = message.nodeOnlyTypedInputs
    if (typeof after !== 'string' || !record || after === before) return
    const typed = record[textHash(before)]
    if (typed === undefined) return
    const at = before.indexOf(typed)
    if (at < 0) return
    const head = before.slice(0, at)
    const tail = before.slice(at + typed.length)
    if (after.length < head.length + tail.length || !after.startsWith(head) || !after.endsWith(tail)) return
    rememberTypedInput(message, after.slice(head.length, after.length - tail.length))
}

/** Whether a message is an input the user sent from the input box, with something they typed in it. */
export function isTypedInput(message: InputMessage | undefined): boolean {
    if (message?.role !== 'user' || !message.time || typeof message.data !== 'string') return false
    const text = typedTextOf(message).trim()
    return text !== '' && text !== '*says nothing*'
}
