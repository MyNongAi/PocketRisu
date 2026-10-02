// Which chats finished a reply since they were last opened, for the chat
// list's status mark (a spinner while a reply runs, then a check). Kept in
// memory only: a reload starts with no marks.
import { writable, type Readable } from 'svelte/store'

export const finishedReplies = writable<Set<string>>(new Set())

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
            const next = new Set(marks)
            for (const key of started) next.delete(key)
            for (const key of ended) next.add(key)
            return next
        })
    })
}

export function clearFinishedReply(chatId: string | undefined): void {
    if (!chatId) return
    finishedReplies.update((marks) => {
        if (!marks.has(chatId)) return marks
        const next = new Set(marks)
        next.delete(chatId)
        return next
    })
}
