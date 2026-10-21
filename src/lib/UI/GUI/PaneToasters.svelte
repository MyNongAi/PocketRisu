<script lang="ts">
    // One toaster per split pane, at the top right of that pane's chat, for
    // the cards of replies written there (requestToastPane.ts). Without the
    // split, or before a pane is measured, they sit where the app's own
    // toaster does.
    import Toaster from './Toaster.svelte'
    import { splitChatOpen } from 'src/ts/chatSplitPane'
    import { MobileGUI } from 'src/ts/stores.svelte'
    import { dockVisible } from 'src/ts/importDock'
    import { PANE_TOASTERS, splitPanesShown } from 'src/ts/status/requestToastPane'
    import type { PaneId } from 'src/ts/chatPanes.svelte'

    type Box = { top: number, right: number, left: number, width: number }
    const PANES = ['main', 'side'] as const
    const GAP = 24
    // The dock's column of folded requests at the window's right edge
    // (RequestStatusDock: 2.5rem buttons 0.5rem from the edge).
    const DOCK_ROOM = 48
    // sonner's card width; a narrower pane gets narrower cards.
    const CARD = 356

    let boxes = $state<Partial<Record<PaneId, Box>>>({})

    $effect(() => {
        // Re-run when the split opens or closes.
        $splitChatOpen
        $MobileGUI
        if (!splitPanesShown()) {
            boxes = {}
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
            boxes = next
        }
        measure()
        const timer = setInterval(measure, 1000)
        window.addEventListener('resize', measure)
        return () => {
            clearInterval(timer)
            window.removeEventListener('resize', measure)
        }
    })

    const dockRoomOf = (box: Box, dock: boolean) => dock && box.right < DOCK_ROOM ? DOCK_ROOM : 0

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
    {#if boxes[pane]}
        {@const box = boxes[pane]}
        <Toaster
            id={PANE_TOASTERS[pane]}
            position="top-right"
            offset={offsetOf(box, $dockVisible)}
            mobileOffset={mobileOffsetOf(box, $dockVisible)}
            width={widthOf(box, $dockVisible)}
        />
    {:else}
        <Toaster id={PANE_TOASTERS[pane]} />
    {/if}
{/each}
