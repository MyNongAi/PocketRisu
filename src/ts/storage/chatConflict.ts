// A chat save that meets a newer server copy (another device wrote in
// between) is never refused: refusing leaves the only copy of what was typed
// in the tab, and the tab can close or reload. Overwriting is lossless when
// this device's copy already holds every message the server has; otherwise
// the server copy is kept as a chat of its own before it is overwritten.

type ChatMessage = { role?: string, data?: string, chatId?: string }
type ChatLike = { message?: ChatMessage[] }

function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
    if (a.role !== b.role || a.data !== b.data) return false
    return !a.chatId || !b.chatId || a.chatId === b.chatId
}

/**
 * True when every server message appears in the local chat, in order and
 * unedited, so writing the local chat over it loses nothing. A message the
 * other device edited or this one deleted makes it false.
 */
export function chatHoldsAllMessages(local: ChatLike, server: ChatLike): boolean {
    const mine = local.message ?? []
    let next = 0
    for (const theirs of server.message ?? []) {
        while (next < mine.length && !sameMessage(mine[next], theirs)) next++
        if (next === mine.length) return false
        next++
    }
    return true
}
