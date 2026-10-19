// Versions of a user input (the user's request, 2026-10-17): every saved edit
// of an input keeps the text it replaced, so the arrows on the input shown
// under a reply step through them in order, starting with the input as it was
// sent. The version shown becomes the input, like a reply's swipes.
//
// A request uses the version shown when send or reroll was pressed; a version
// picked after that is for the next request (the user's request, 2026-10-19).
//
// A reply also records which input its request was made from, per swipe, so
// that version can be pointed out. Only hashes are kept (reply text -> input
// text), so a long input is not copied into every reply; a reply edited since
// simply loses the mark.

export const MAX_INPUT_VERSIONS = 20
const MAX_REQUEST_MARKS = 64

export interface VersionedInput {
    data: string
    nodeOnlyInputVersions?: string[]
}

export interface RequestMarkedReply {
    data: string
    swipes?: string[]
    nodeOnlyRequestInputs?: Record<string, string>
}

/** Save `next` as the input, keeping the text it replaces as a version. */
export function recordInputEdit(message: VersionedInput, next: string): boolean {
    if (message.data === next) return false
    const versions = message.nodeOnlyInputVersions?.length ? [...message.nodeOnlyInputVersions] : []
    if (!versions.includes(message.data)) versions.push(message.data)
    if (!versions.includes(next)) versions.push(next)
    message.nodeOnlyInputVersions = versions.slice(-MAX_INPUT_VERSIONS)
    message.data = next
    return true
}

/** Index of the shown input among its versions (-1 with fewer than two). */
export function inputVersionIndex(message: VersionedInput | null | undefined): number {
    const versions = message?.nodeOnlyInputVersions
    if (!message || !versions || versions.length < 2) return -1
    const index = versions.lastIndexOf(message.data)
    return index >= 0 ? index : versions.length - 1
}

/** Show the previous (-1) or next (1) version, wrapping. Returns whether it changed. */
export function stepInputVersion(message: VersionedInput, step: -1 | 1): boolean {
    let list = message.nodeOnlyInputVersions
    if (!list || list.length < 2) return false
    let from = list.lastIndexOf(message.data)
    // An input changed outside the version list joins it first.
    if (from < 0) {
        list = [...list, message.data].slice(-MAX_INPUT_VERSIONS)
        message.nodeOnlyInputVersions = list
        from = list.length - 1
    }
    const next = ((from + step) % list.length + list.length) % list.length
    if (list[next] === message.data) return false
    message.data = list[next]
    return true
}

/** A short hash of a text (FNV-1a, 32 bits, with the length). */
export function textHash(text: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return `${(hash >>> 0).toString(36)}.${text.length.toString(36)}`
}

/** After a reply is written: remember the input its request was made from. */
export function recordRequestInput(reply: RequestMarkedReply, input: string) {
    const kept = new Set([reply.data, ...(reply.swipes ?? [])].map(textHash))
    const marks: Record<string, string> = {}
    for (const [key, value] of Object.entries(reply.nodeOnlyRequestInputs ?? {})) {
        if (kept.has(key)) marks[key] = value
    }
    marks[textHash(reply.data)] = textHash(input)
    const keys = Object.keys(marks)
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REQUEST_MARKS))) delete marks[key]
    reply.nodeOnlyRequestInputs = marks
}

/** The input a request read, by the message it came from. */
export interface SentInput {
    chatId: string
    text: string
}

/**
 * Mark `reply` with the input its request read (`sent`), when `input`, the
 * message right before the reply, is the one that was read. The text comes
 * from the request, not from `input`: the arrows may have shown another
 * version while the reply was being written.
 */
export function recordSentRequestInput(reply: RequestMarkedReply, input: { chatId?: string } | null | undefined, sent: SentInput | null | undefined): boolean {
    if (!sent || !input?.chatId || input.chatId !== sent.chatId) return false
    recordRequestInput(reply, sent.text)
    return true
}

/** The newest input of a chat as it is when send or reroll is pressed. */
export function pressedInput(messages: readonly ({ role?: string, data?: string, chatId?: string, disabled?: unknown, isComment?: boolean } | undefined)[] | null | undefined): SentInput | undefined {
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
        const message = messages![i]
        if (!message || message.disabled || message.isComment) continue
        if (message.role !== 'user') continue
        return message.chatId ? { chatId: message.chatId, text: message.data ?? '' } : undefined
    }
    return undefined
}

/**
 * The text a request reads from `message`: the version shown when the
 * request was pressed (`pressed`) if the arrows or a saved edit have shown
 * another of its versions since. A change from anywhere else (a trigger
 * rewriting the input) is read as it is.
 */
export function requestInputText(message: VersionedInput & { chatId?: string }, pressed: SentInput | null | undefined): string {
    if (!pressed || message.chatId !== pressed.chatId || message.data === pressed.text) return message.data
    const versions = message.nodeOnlyInputVersions ?? []
    return versions.includes(message.data) && versions.includes(pressed.text) ? pressed.text : message.data
}

/** Whether `input` is the one the shown reply's request was made from. */
export function isRequestInput(reply: RequestMarkedReply | null | undefined, input: string | null | undefined): boolean {
    if (!reply || input == null) return false
    const mark = reply.nodeOnlyRequestInputs?.[textHash(reply.data)]
    return !!mark && mark === textHash(input)
}
