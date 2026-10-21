<script lang="ts">
    // Driver that bridges the request-status store to sonner. Mounted once
    // (next to <Toaster/> in App.svelte), renders no DOM of its own. For each
    // request entry it issues ONE persistent sonner custom toast keyed by
    // `req:<generationId>` and dismisses it after a short retention once the
    // request reaches a terminal phase. The toast body (RequestStatusToast)
    // subscribes to the store itself, so live updates need no re-issue here —
    // this driver only manages create / dismiss lifecycle.
    //
    // The `req:` id namespace keeps these separate from confirm/error toasts
    // (notify*), so they never collide even on the same Toaster. See
    // .agent/notes/request-status-toast-infra.md §4-3.
    import { onDestroy } from 'svelte'
    import { get } from 'svelte/store'
    import { toast } from 'svelte-sonner'
    import { requestStatuses, isTerminalPhase, clearStatus } from 'src/ts/status/requestStatus'
    import RequestStatusToast, { REQUEST_TOAST_CLASS } from './RequestStatusToast.svelte'
    import { dismissRequestToast, keepsDoneButton, minimizedRequests, requestToastDismissed, requestToastShown, staysOpenUnseen, unminimizeRequest } from 'src/ts/status/requestStatusDock'
    import { DBState, selIdState } from 'src/ts/stores.svelte'
    import { paneToasterFor } from 'src/ts/status/requestToastPane'

    function currentChatId(): string | null {
        const character = DBState.db.characters?.[selIdState.selId]
        return character?.chats?.[character.chatPage]?.id ?? null
    }

    // How long a finished toast lingers so the user can read the final
    // tokens / cache savings before it disappears.
    const RETENTION_MS = 4000

    // genIds we've issued a toast for, and pending dismissal timers.
    const shown = new Set<string>()
    const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>()
    // Open cards of a reply finished in another chat (staysOpenUnseen).
    const keptUnseen = new Set<string>()

    function toastId(id: string): string {
        return `req:${id}`
    }

    function scheduleDismiss(id: string): void {
        if (dismissTimers.has(id)) return
        const t = setTimeout(() => {
            dismissTimers.delete(id)
            shown.delete(id)
            dismissRequestToast(id)
            unminimizeRequest(id)
            // Drop the store entry too so the map doesn't grow unbounded.
            clearStatus(id)
        }, RETENTION_MS)
        dismissTimers.set(id, t)
    }

    // A swipe folds a running request's card into the dock, like its "−"
    // (requestStatusDock.ts, the user's request 2026-10-18); a finished one
    // just closes. `shown` keeps the id either way, so later store updates
    // for the same request do not re-issue the card; the dock's button does.
    const unsub = requestStatuses.subscribe((map) => {
        for (const [id, entry] of map) {
            if (!shown.has(id)) {
                shown.add(id)
                requestToastShown(id)
                toast.custom(RequestStatusToast, {
                    id: toastId(id),
                    // Over the pane of its chat while split (requestToastPane.ts).
                    toasterId: paneToasterFor(entry.chatId),
                    class: REQUEST_TOAST_CLASS,
                    duration: Number.POSITIVE_INFINITY,
                    componentProps: { id },
                    onDismiss: () => requestToastDismissed(id),
                })
            }
            if (isTerminalPhase(entry.phase)) {
                // Folded and written in another chat: the dock's check stays
                // until it is tapped (RequestStatusDock clears the entry).
                if (get(minimizedRequests).includes(id) && keepsDoneButton(entry, currentChatId())) continue
                // Open and finished in another chat: the card stays until that
                // chat is opened (the effect below), or it is folded or swiped.
                if (!get(minimizedRequests).includes(id) && staysOpenUnseen(entry, currentChatId())) {
                    keptUnseen.add(id)
                    continue
                }
                scheduleDismiss(id)
            } else if (dismissTimers.has(id)) {
                // Revived (e.g. fallback/retry reuses the same generationId): the
                // entry went terminal, scheduled a dismiss, then restarted. Cancel
                // the pending dismiss so the now-live toast isn't cleared mid-flight.
                clearTimeout(dismissTimers.get(id))
                dismissTimers.delete(id)
            }
        }
        // Entries removed from the store while still shown (e.g. cleared early):
        // dismiss their toasts.
        for (const id of [...shown]) {
            if (!map.has(id) && !dismissTimers.has(id)) {
                shown.delete(id)
                dismissRequestToast(id)
            }
        }
    })

    // Cards kept up for a reply finished in another chat leave as usual once
    // that chat is the one on screen.
    const chatOnScreen = $derived.by(() => {
        const character = DBState.db.characters?.[selIdState.selId]
        return character?.chats?.[character.chatPage]?.id ?? null
    })
    $effect(() => {
        const here = chatOnScreen
        for (const id of [...keptUnseen]) {
            const entry = get(requestStatuses).get(id)
            if (!entry || get(minimizedRequests).includes(id)) {
                keptUnseen.delete(id)
                continue
            }
            if (entry.chatId === here) {
                keptUnseen.delete(id)
                scheduleDismiss(id)
            }
        }
    })

    // Folded while kept up: the dock takes it (a done reply keeps its check
    // there; anything else leaves as usual).
    const unsubFolded = minimizedRequests.subscribe((ids) => {
        for (const id of ids) {
            if (!keptUnseen.delete(id)) continue
            const entry = get(requestStatuses).get(id)
            if (!entry || !keepsDoneButton(entry, currentChatId())) scheduleDismiss(id)
        }
    })

    onDestroy(() => {
        unsubFolded()
        unsub()
        for (const t of dismissTimers.values()) clearTimeout(t)
        dismissTimers.clear()
    })
</script>
