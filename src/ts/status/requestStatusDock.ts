// Request-status toasts folded into round buttons (the user's request,
// 2026-10-17): the toast's "−" folds it, the button spins while the reply is
// being written and opens the toast again on a tap; once the reply is done it
// shows a check, and a tap opens the chat it was written in. One action per
// state, so a tap never means both "open the toast" and "go to the chat".

import { get, writable } from 'svelte/store'
import { toast } from 'svelte-sonner'
import { isTerminalPhase, requestStatuses, type RequestStatusEntry } from './requestStatus'

/** Ids (generation ids) of the folded toasts, in folding order. */
export const minimizedRequests = writable<string[]>([])

export function minimizeRequest(id: string): void {
    minimizedRequests.update((ids) => (ids.includes(id) ? ids : [...ids, id]))
}

export function unminimizeRequest(id: string): void {
    minimizedRequests.update((ids) => (ids.includes(id) ? ids.filter((other) => other !== id) : ids))
}

// A swipe folds a request card like its "−" (the user's request, 2026-10-18:
// swiped away, a running request's card was gone for good). sonner reports
// every dismissal the same way, so the app's own (the "−", a finished card
// leaving) are marked here first and are not taken for swipes.
const quietDismissals = new Set<string>()

/** Close a request card from the app (not a swipe). */
export function dismissRequestToast(id: string): void {
    quietDismissals.add(id)
    toast.dismiss(`req:${id}`)
}

/** A request card is (re)shown: no stale mark from an earlier one. */
export function requestToastShown(id: string): void {
    quietDismissals.delete(id)
}

/** sonner's onDismiss for a request card: a swipe on a running request folds it. */
export function requestToastDismissed(id: string): void {
    if (quietDismissals.delete(id)) return
    const entry = get(requestStatuses).get(id)
    if (entry && !isTerminalPhase(entry.phase)) minimizeRequest(id)
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
/**
 * Whether a finished card that is open (not folded) stays up: a main reply
 * done or failed in another chat than the one on screen (the user's request,
 * 2026-10-19: it closed on its own while the reader was elsewhere). It closes
 * as usual once that chat is opened.
 */
export function staysOpenUnseen(entry: Pick<RequestStatusEntry, 'phase' | 'chatId' | 'kind'>, currentChatId: string | null | undefined): boolean {
    return (entry.phase === 'done' || entry.phase === 'failed') && entry.kind === 'main' && !!entry.chatId && entry.chatId !== currentChatId
}

export function keepsDoneButton(entry: Pick<RequestStatusEntry, 'phase' | 'chatId' | 'kind'>, currentChatId: string | null | undefined): boolean {
    return entry.phase === 'done' && entry.kind === 'main' && !!entry.chatId && entry.chatId !== currentChatId
}
