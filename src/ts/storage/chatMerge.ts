// A chat saved over a newer server copy (another device wrote in between) is
// merged by message id instead of keeping the server copy as a chat of its
// own (the user's request, 2026-10-21: the same chat open on two devices kept
// spawning "(다른 기기 사본)" chats). The base is the message list as this
// device last synced it, so each side's additions, edits and deletions can be
// told apart:
//   - a message only one side changed takes that side's version;
//   - a message one side added stays, at its place after the message before it;
//   - a message one side deleted, untouched on the other, goes.
// A message both sides changed differently, one changed on one side and
// deleted on the other, or messages without unique ids cannot be merged:
// the caller then keeps the server copy as before (chatConflict.ts).

import { messageFingerprint } from './chatFingerprint'

type Message = { chatId?: string, time?: number }

export interface MessageBaseEntry {
    id: string
    fp: string
}

/** The messages as synced: their ids and fingerprints. Null when an id is missing or repeated. */
export function messageBase(messages: readonly Message[] | undefined): MessageBaseEntry[] | null {
    const seen = new Set<string>()
    const entries: MessageBaseEntry[] = []
    for (const message of messages ?? []) {
        const id = message?.chatId
        if (typeof id !== 'string' || id.length === 0 || seen.has(id)) return null
        seen.add(id)
        entries.push({ id, fp: messageFingerprint(message) })
    }
    return entries
}

function byId<T extends Message>(messages: readonly T[]): Map<string, T> | null {
    const map = new Map<string, T>()
    for (const message of messages) {
        const id = message?.chatId
        if (typeof id !== 'string' || id.length === 0 || map.has(id)) return null
        map.set(id, message)
    }
    return map
}

/**
 * `local` and `server` merged against `base`, or null when they cannot be
 * merged without losing one side's change. Message objects are reused, never
 * copied.
 */
export function mergeChatMessages<T extends Message>(
    base: readonly MessageBaseEntry[],
    local: readonly T[],
    server: readonly T[],
): T[] | null {
    const mine = byId(local)
    const theirs = byId(server)
    if (!mine || !theirs) return null
    const baseFp = new Map(base.map((entry) => [entry.id, entry.fp]))

    // Which version of each message stays (undefined: it goes).
    const kept = new Map<string, T>()
    for (const id of new Set([...mine.keys(), ...theirs.keys()])) {
        const l = mine.get(id)
        const s = theirs.get(id)
        const b = baseFp.get(id)
        if (l && s) {
            const lfp = messageFingerprint(l)
            const sfp = messageFingerprint(s)
            if (lfp === sfp || sfp === b) kept.set(id, l)
            else if (lfp === b) kept.set(id, s)
            else return null
        } else if (l) {
            if (b === undefined) kept.set(id, l)               // added here
            else if (messageFingerprint(l) !== b) return null // changed here, deleted there
        } else if (s) {
            if (b === undefined) kept.set(id, s)               // added there
            else if (messageFingerprint(s) !== b) return null // changed there, deleted here
        }
    }

    // The server's order, with this device's additions placed after the
    // message they followed here. Several additions after the same message
    // (both sides wrote on from it) go in time order, theirs first on a tie.
    const merged: T[] = server.filter((message) => kept.has(message.chatId!)).map((message) => kept.get(message.chatId!)!)
    const placed = new Set(merged.map((message) => message.chatId!))
    let previous: string | null = null
    for (const message of local) {
        const id = message.chatId!
        if (!placed.has(id) && kept.has(id)) {
            let at = previous === null ? 0 : merged.findIndex((entry) => entry.chatId === previous) + 1
            // Step over the other side's additions that came first.
            while (at < merged.length && !baseFp.has(merged[at].chatId!) && !mine.has(merged[at].chatId!)
                && (merged[at].time ?? 0) <= (message.time ?? 0)) at++
            merged.splice(at, 0, message)
            placed.add(id)
        }
        if (placed.has(id)) previous = id
    }
    return merged
}
