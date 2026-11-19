// REPLY-STATUS-OUTCOME: the chat list's mark tells a failed reply from a finished one.
// Memory only: a reload starts with no marks.
import { writable, type Readable } from 'svelte/store'

export type ReplyOutcome = 'done' | 'failed'
export const finishedReplies = writable<Map<string, ReplyOutcome>>(new Map())
const pendingOutcomes = new Map<string, ReplyOutcome | 'aborted'>()
const lastOutcomes = new Map<string, ReplyOutcome | 'aborted'>()

/** Record the result of the whole send before its generation entry is removed. */
export function recordReplyOutcome(chatId: string | undefined, outcome: ReplyOutcome | 'aborted'): void {
    if (chatId && pendingOutcomes.get(chatId) !== 'aborted') pendingOutcomes.set(chatId, outcome)
}

/** The concluded send result survives opening the chat until presence has sent its end event. */
export function lastReplyOutcome(chatId: string): ReplyOutcome | 'aborted' | undefined {
    return lastOutcomes.get(chatId)
}

/**
 * Follows a map of running generations keyed by chat id: a chat whose entry
 * disappears gets a mark, one that starts again loses it.
 */
export function trackFinishedReplies(running: Readable<Map<string, unknown>>, ignore: readonly string[] = []): () => void {
    let previous = new Set<string>()
    return running.subscribe((states) => {
        const now = new Set([...states.keys()].filter((key) => !ignore.includes(key)))
        const ended = [...previous].filter((key) => !now.has(key))
        const started = [...now].filter((key) => !previous.has(key))
        previous = now
        if (ended.length === 0 && started.length === 0) return
        finishedReplies.update((marks) => {
            const next = new Map(marks)
            for (const key of started) {
                next.delete(key)
                pendingOutcomes.delete(key)
                lastOutcomes.delete(key)
            }
            for (const key of ended) {
                const outcome = pendingOutcomes.get(key) ?? 'done'
                pendingOutcomes.delete(key)
                lastOutcomes.set(key, outcome)
                if (outcome !== 'aborted') next.set(key, outcome)
            }
            return next
        })
    })
}

/** A reply finished elsewhere (another device, sync/remoteActivity.ts). */
export function markFinishedReply(chatId: string | undefined, outcome: ReplyOutcome = 'done'): void {
    if (!chatId) return
    finishedReplies.update((marks) => {
        if (marks.get(chatId) === outcome) return marks
        const next = new Map(marks)
        next.set(chatId, outcome)
        return next
    })
}

export function clearFinishedReply(chatId: string | undefined): void {
    if (!chatId) return
    finishedReplies.update((marks) => {
        if (!marks.has(chatId)) return marks
        const next = new Map(marks)
        next.delete(chatId)
        return next
    })
}
