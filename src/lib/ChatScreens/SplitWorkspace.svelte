<script lang="ts">
    // The PC split: whatever the main window shows on the left (the chat, or
    // settings) and the second workspace on the right. The right pane used
    // to live inside ChatScreen, so opening settings on the left unmounted it
    // and the right pane reloaded (and booted a new session) every time (the
    // user's report, 2026-10-17). It now sits beside the left content here,
    // and the left content keeps the same parent whether or not the split is
    // open, so toggling the split does not remount the chat either.
    import type { Snippet } from 'svelte'
    import { onDestroy, onMount } from 'svelte'
    import { MobileGUI } from 'src/ts/stores.svelte'
    import { clampSplitWidth, getSplitWidthBounds, isEmbeddedRisuPane, SPLIT_DIVIDER_PX, splitChatOpen, splitChatWidth } from 'src/ts/chatSplitPane'
    import SecondaryChatPanel from './SecondaryChatPanel.svelte'

    let { children }: { children: Snippet } = $props()

    const enabled = $derived($splitChatOpen && !$MobileGUI && !isEmbeddedRisuPane)
    let splitRoot: HTMLDivElement | null = $state(null)
    let stopSplitResize: (() => void) | null = null

    function beginSplitResize(event: PointerEvent) {
        if (!splitRoot) return
        event.preventDefault()
        const pointerId = event.pointerId
        const handle = event.currentTarget as HTMLElement
        handle.setPointerCapture?.(pointerId)

        const move = (moveEvent: PointerEvent) => {
            if (!splitRoot) return
            const rect = splitRoot.getBoundingClientRect()
            splitChatWidth.set(clampSplitWidth(rect.right - moveEvent.clientX, rect.width))
        }
        const stop = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', stop)
            window.removeEventListener('pointercancel', stop)
            stopSplitResize = null
        }
        stopSplitResize?.()
        stopSplitResize = stop
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', stop)
        window.addEventListener('pointercancel', stop)
    }

    function resetSplitWidth() {
        if (!splitRoot) return
        splitChatWidth.set(clampSplitWidth(splitRoot.clientWidth / 2, splitRoot.clientWidth))
    }

    function handleSplitDividerKeydown(event: KeyboardEvent) {
        if (!splitRoot) return
        const bounds = getSplitWidthBounds(splitRoot.clientWidth)
        const step = event.shiftKey ? 80 : 24
        let nextWidth: number | undefined
        if (event.key === 'ArrowLeft') nextWidth = $splitChatWidth + step
        if (event.key === 'ArrowRight') nextWidth = $splitChatWidth - step
        if (event.key === 'Home') nextWidth = bounds.max
        if (event.key === 'End') nextWidth = bounds.min
        if (nextWidth === undefined) return
        event.preventDefault()
        splitChatWidth.set(clampSplitWidth(nextWidth, splitRoot.clientWidth))
    }

    onDestroy(() => stopSplitResize?.())
    onMount(() => {
        const clampStoredWidth = () => {
            if (!splitRoot) return
            splitChatWidth.update((width) => clampSplitWidth(width, splitRoot?.clientWidth ?? window.innerWidth))
        }
        clampStoredWidth()
        window.addEventListener('resize', clampStoredWidth)
        return () => window.removeEventListener('resize', clampStoredWidth)
    })
</script>

<div class="flex h-full w-full min-w-0" bind:this={splitRoot}>
    <!-- Same flex row as <main> for the left content (sidebar + chat, or
         settings). Contained while split, so user CSS with position:fixed
         stays inside the left workspace like the right pane's iframe. -->
    <div class="relative flex h-full min-w-0 grow" class:split-chat-contained={enabled}>
        {@render children()}
    </div>
    {#if enabled}
        <div
            class="split-chat-divider h-full shrink-0 cursor-col-resize border-0 bg-darkborderc p-0 transition-colors hover:bg-primary focus-visible:bg-primary focus-visible:outline-none"
            style:width={`${SPLIT_DIVIDER_PX}px`}
            role="slider"
            aria-label="Resize split chat"
            aria-orientation="vertical"
            aria-valuemin={getSplitWidthBounds(splitRoot?.clientWidth ?? 0).min}
            aria-valuemax={getSplitWidthBounds(splitRoot?.clientWidth ?? 0).max}
            aria-valuenow={$splitChatWidth}
            tabindex="0"
            onpointerdown={beginSplitResize}
            ondblclick={resetSplitWidth}
            onkeydown={handleSplitDividerKeydown}
        ></div>
        <div class="h-full min-w-0 shrink-0" style:width={`${$splitChatWidth}px`}>
            <SecondaryChatPanel />
        </div>
    {/if}
</div>

<style>
    .split-chat-divider {
        touch-action: none;
    }

    .split-chat-contained {
        /* User CSS often places chat controls with position:fixed. Paint
           containment gives the primary workspace its own fixed-position
           viewport, matching the secondary iframe instead of the full page. */
        contain: paint;
        isolation: isolate;
        overflow: clip;
    }
</style>
