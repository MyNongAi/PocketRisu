<script lang="ts">
    // One toaster per split pane, at the top right of that pane's chat, for
    // the cards of replies written there (requestToastPane.ts). Without the
    // split, or before a pane is measured, they sit where the app's own
    // toaster does.
    import Toaster from './Toaster.svelte'
    import { splitChatOpen } from 'src/ts/chatSplitPane'
    import { MobileGUI } from 'src/ts/stores.svelte'
    import { importDockPill } from 'src/ts/importDock'
    import { minimizedRequests } from 'src/ts/status/requestStatusDock'
    import { requestStatuses } from 'src/ts/status/requestStatus'
    import { PANE_TOASTERS, dockPaneFor, paneToastBoxes, splitPanesShown, type PaneBox } from 'src/ts/status/requestToastPane'
    import type { PaneId } from 'src/ts/chatPanes.svelte'

    type Box = PaneBox
    const PANES = ['main', 'side'] as const
    const GAP = 24
    // Reserve the folded-button column at this pane's right edge, or the
    // window's download button beside the rightmost pane.
    const DOCK_ROOM = 48
    // sonner's card width; a narrower pane gets narrower cards.
    const CARD = 356

    $effect(() => {
        // Re-run when the split opens or closes.
        $splitChatOpen
        $MobileGUI
        if (!splitPanesShown()) {
            paneToastBoxes.set({})
            return
        }
        let last = ''
        // Panes move with the divider, the panels and the bot list without
        // changing the window, so they are read again every second.
        const measure = () => {
            const next: Partial<Record<PaneId, Box>> = {}
            for (const pane of PANES) {
                const rect = document.querySelector(`[data-chat-pane="${pane}"]`)?.getBoundingClientRect()
                if (rect && rect.width > 0 && rect.height > 0) {
                    next[pane] = {
                        top: Math.round(rect.top),
                        right: Math.round(window.innerWidth - rect.right),
                        left: Math.round(rect.left),
                        width: Math.round(rect.width),
                    }
                }
            }
            const key = JSON.stringify(next)
            if (key === last) return
            last = key
            paneToastBoxes.set(next)
        }
        measure()
        const timer = setInterval(measure, 1000)
        window.addEventListener('resize', measure)
        return () => {
            clearInterval(timer)
            window.removeEventListener('resize', measure)
        }
    })

    const dockRoomOf = (box: Box, dock: boolean) => dock ? DOCK_ROOM : 0

    function offsetOf(box: Box, dock: boolean) {
        return { top: `${box.top + GAP}px`, right: `${box.right + GAP + dockRoomOf(box, dock)}px` }
    }

    // Under 600px sonner lays cards across the window from these instead.
    function mobileOffsetOf(box: Box, dock: boolean) {
        return { top: `${box.top + 16}px`, right: `${box.right + 16 + dockRoomOf(box, dock)}px`, left: `${box.left + 16}px` }
    }

    function widthOf(box: Box, dock: boolean): number | undefined {
        const room = box.width - 2 * GAP - dockRoomOf(box, dock)
        return room < CARD ? Math.max(160, room) : undefined
    }
</script>

{#each PANES as pane (pane)}
    {#if $paneToastBoxes[pane]}
        {@const box = $paneToastBoxes[pane]}
        {@const dock = ($importDockPill.count > 0 && box.right < DOCK_ROOM) || $minimizedRequests.some((id) => dockPaneFor($requestStatuses.get(id)?.chatId, $paneToastBoxes) === pane)}
        <Toaster
            id={PANE_TOASTERS[pane]}
            position="top-right"
            offset={offsetOf(box, dock)}
            mobileOffset={mobileOffsetOf(box, dock)}
            width={widthOf(box, dock)}
        />
    {:else}
        <Toaster id={PANE_TOASTERS[pane]} />
    {/if}
{/each}
