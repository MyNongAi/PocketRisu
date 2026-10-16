// Request-status toasts folded into round buttons (the user's request,
// 2026-10-17): the toast's "−" folds it, the button spins while the reply is
// being written and opens the toast again on a tap; once the reply is done it
// shows a check, and a tap opens the chat it was written in. One action per
// state, so a tap never means both "open the toast" and "go to the chat".

import { get, writable } from 'svelte/store'
import { isTerminalPhase, type RequestStatusEntry } from './requestStatus'

/** Ids (generation ids) of the folded toasts, in folding order. */
export const minimizedRequests = writable<string[]>([])

export function minimizeRequest(id: string): void {
    minimizedRequests.update((ids) => (ids.includes(id) ? ids : [...ids, id]))
}

export function unminimizeRequest(id: string): void {
    minimizedRequests.update((ids) => (ids.includes(id) ? ids.filter((other) => other !== id) : ids))
}

export function isMinimizedRequest(id: string): boolean {
    return get(minimizedRequests).includes(id)
}

export type DockState = 'running' | 'done' | 'failed'

export function dockState(entry: Pick<RequestStatusEntry, 'phase'>): DockState {
    if (!isTerminalPhase(entry.phase)) return 'running'
    return entry.phase === 'done' ? 'done' : 'failed'
}

/**
 * Whether a finished folded request stays as a check button: a main reply
 * written in another chat than the one on screen. Anything else (an aux
 * request, a reply in the chat being read, a failure or a cancel) leaves
 * with its toast as before.
 */
export function keepsDoneButton(entry: Pick<RequestStatusEntry, 'phase' | 'chatId' | 'kind'>, currentChatId: string | null | undefined): boolean {
    return entry.phase === 'done' && entry.kind === 'main' && !!entry.chatId && entry.chatId !== currentChatId
}
