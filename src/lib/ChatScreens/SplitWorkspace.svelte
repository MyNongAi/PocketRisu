<script lang="ts">
    // The PC split: whatever the main window shows (the chat, or settings) and
    // the second chat pane. The right pane used to live inside ChatScreen, so
    // opening settings unmounted it and it reloaded every time (the user's
    // report, 2026-10-17). It sits beside the main content here, and the main
    // content keeps the same parent whether or not the split is open, so
    // toggling the split does not remount the chat either.
    //
    // Docked (a desktop-sized window, the user's request 2026-10-21): one bot
    // list for both panes, at the start, between the panes or at the end;
    // each pane with its own character panel, opened and closed by its arrow;
    // side by side or stacked; the divider resizes, and its menu (right-click,
    // or a long press) swaps the panes, stacks or unstacks them, moves the bot
    // list and evens the sizes (splitLayout.svelte.ts).
    import type { Snippet } from 'svelte'
    import { onDestroy, onMount, untrack } from 'svelte'
    import { DynamicGUI, MobileGUI, settingsOpen } from 'src/ts/stores.svelte'
    import { clampSplitHeight, clampSplitWidth, getSplitWidthBounds, isEmbeddedRisuPane, SPLIT_DIVIDER_PX, splitChatHeight, splitChatOpen, splitChatWidth } from 'src/ts/chatSplitPane'
    import SecondaryChatPanel from './SecondaryChatPanel.svelte'
    import Sidebar from '../SideBars/Sidebar.svelte'
    import { restorePanesAfterBoot, returnToMainPane, swapPanes } from 'src/ts/paneActivation'
    import { startPaneSync } from 'src/ts/chatPanes.svelte'
    import { railPlace, setSplitLayout, splitLayout, type RailPlace } from 'src/ts/splitLayout.svelte'
    import { alertSelect } from 'src/ts/alert'
    import { language } from 'src/lang'

    let { children, openLegacyGrid = () => {} }: { children: Snippet, openLegacyGrid?: () => void } = $props()

    const enabled = $derived($splitChatOpen && !$MobileGUI && !isEmbeddedRisuPane)
    // The docked layout; a narrow (DynamicGUI) window keeps the sidebar as an overlay (App).
    const docked = $derived(enabled && !$DynamicGUI)
    const column = $derived(docked && splitLayout.orientation === 'column')
    const rail = $derived(railPlace())
    $effect(() => {
        if (!enabled) returnToMainPane()
    })
    // Stacking keeps the lower pane's height within the window.
    $effect(() => {
        if (!column || !paneRoot) return
        const span = paneRoot.clientHeight
        untrack(() => splitChatHeight.update((height) => clampSplitHeight(height, span)))
    })
    onMount(() => {
        const stopSync = startPaneSync()
        // After bootstrap's own restore of the last chat (100 ms after load).
        const restore = setTimeout(() => { if (enabled) restorePanesAfterBoot() }, 400)
        return () => { stopSync(); clearTimeout(restore) }
    })
    // The two panes and the divider between them (the bot list sits outside it at the ends).
    let paneRoot: HTMLDivElement | null = $state(null)
    let stopSplitResize: (() => void) | null = null

    const paneSpan = () => column ? (paneRoot?.clientHeight ?? window.innerHeight) : (paneRoot?.clientWidth ?? window.innerWidth)
    const clampSize = (size: number) => column ? clampSplitHeight(size, paneSpan()) : clampSplitWidth(size, paneSpan())
    const setSize = (size: number) => (column ? splitChatHeight : splitChatWidth).set(clampSize(size))

    // A touch that stays put this long opens the divider's menu; moving first resizes.
    const LONG_PRESS_MS = 550
    const MOVE_SLOP_PX = 8

    function beginSplitResize(event: PointerEvent) {
        if (event.button !== 0) return
        event.preventDefault()
        const handle = event.currentTarget as HTMLElement
        try {
            handle.setPointerCapture?.(event.pointerId)
        } catch {
            // A pointer the browser no longer tracks: the window listeners still follow it.
        }
        const start = column ? event.clientY : event.clientX
        const startSize = column ? $splitChatHeight : $splitChatWidth
        const touch = event.pointerType === 'touch'
        let resizing = !touch
        let pressTimer = touch ? setTimeout(() => { stop(); void openDividerMenu() }, LONG_PRESS_MS) : null

        const move = (moveEvent: PointerEvent) => {
            const delta = (column ? moveEvent.clientY : moveEvent.clientX) - start
            if (!resizing) {
                if (Math.abs(delta) < MOVE_SLOP_PX) return
                resizing = true
                if (pressTimer) { clearTimeout(pressTimer); pressTimer = null }
            }
            setSize(startSize - delta)
        }
        const stop = () => {
            if (pressTimer) { clearTimeout(pressTimer); pressTimer = null }
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

    function resetSplitSize() {
        setSize(paneSpan() / 2)
    }

    function handleSplitDividerKeydown(event: KeyboardEvent) {
        const step = event.shiftKey ? 80 : 24
        const size = column ? $splitChatHeight : $splitChatWidth
        const grow = column ? 'ArrowUp' : 'ArrowLeft'
        const shrink = column ? 'ArrowDown' : 'ArrowRight'
        let next: number | undefined
        if (event.key === grow) next = size + step
        if (event.key === shrink) next = size - step
        if (event.key === 'Home') next = Number.MAX_SAFE_INTEGER
        if (event.key === 'End') next = 0
        if (next === undefined) return
        event.preventDefault()
        setSize(next)
    }

    async function openDividerMenu(event?: MouseEvent) {
        event?.preventDefault()
        if (!docked) return
        const row = splitLayout.orientation === 'row'
        const railChoices: [RailPlace, string][] = row
            ? [['start', language.splitRailStart], ['center', language.splitRailCenter], ['end', language.splitRailEnd]]
            : [['start', language.splitRailStart], ['end', language.splitRailEnd]]
        const actions: [string, () => void][] = [
            [row ? language.splitSwapRow : language.splitSwapColumn, () => swapPanes()],
            [row ? language.splitToColumn : language.splitToRow, () => setSplitLayout({ orientation: row ? 'column' : 'row' })],
            ...railChoices.filter(([place]) => place !== rail).map(([place, label]) => [label, () => setSplitLayout({ railAt: place })] as [string, () => void]),
            [language.splitEven, resetSplitSize],
        ]
        const selected = parseInt(await alertSelect([...actions.map(([label]) => label), language.cancel]))
        actions[selected]?.[1]()
    }

    onDestroy(() => stopSplitResize?.())
    onMount(() => {
        const clampStoredSizes = () => {
            if (!paneRoot) return
            splitChatWidth.update((width) => clampSplitWidth(width, paneRoot?.clientWidth ?? window.innerWidth))
            if (column) splitChatHeight.update((height) => clampSplitHeight(height, paneRoot?.clientHeight ?? window.innerHeight))
        }
        clampStoredSizes()
        window.addEventListener('resize', clampStoredSizes)
        return () => window.removeEventListener('resize', clampStoredSizes)
    })
</script>

{#snippet botList()}
    <div class="split-rail flex h-full shrink-0">
        <Sidebar part="rail" hidden={false} {openLegacyGrid} />
    </div>
{/snippet}

<div class="flex h-full w-full min-w-0">
    {#if docked && rail === 'start'}{@render botList()}{/if}
    <div class="flex h-full min-w-0 grow" class:flex-col={column} bind:this={paneRoot}>
        <!-- The main pane: its panel, then the main content (chat or settings).
             Contained while split, so user CSS with position:fixed stays inside it. -->
        <div class="split-main relative flex min-w-0 min-h-0 grow" class:h-full={!column} class:split-chat-contained={enabled} class:split-main-docked={docked && !column}>
            {#if docked && splitLayout.panelOpen.main && !$settingsOpen}
                <Sidebar part="panel" pane="main" hidden={false} {openLegacyGrid} />
            {/if}
            <div class="relative flex h-full min-w-0 grow">
                {@render children()}
            </div>
        </div>
        {#if enabled}
            <div
                class="split-chat-divider shrink-0 border-0 bg-darkborderc p-0 transition-colors hover:bg-primary focus-visible:bg-primary focus-visible:outline-none"
                class:cursor-col-resize={!column}
                class:cursor-row-resize={column}
                class:h-full={!column}
                class:w-full={column}
                style:width={column ? undefined : `${SPLIT_DIVIDER_PX}px`}
                style:height={column ? `${SPLIT_DIVIDER_PX}px` : undefined}
                role="slider"
                aria-label={language.splitDividerLabel}
                aria-orientation={column ? 'horizontal' : 'vertical'}
                aria-valuemin={column ? 0 : getSplitWidthBounds(paneRoot?.clientWidth ?? 0).min}
                aria-valuemax={column ? (paneRoot?.clientHeight ?? 0) : getSplitWidthBounds(paneRoot?.clientWidth ?? 0).max}
                aria-valuenow={column ? $splitChatHeight : $splitChatWidth}
                title={docked ? language.splitDividerLabel : undefined}
                tabindex="0"
                onpointerdown={beginSplitResize}
                ondblclick={resetSplitSize}
                onkeydown={handleSplitDividerKeydown}
                oncontextmenu={openDividerMenu}
            ></div>
            {#if docked && rail === 'center'}{@render botList()}{/if}
            <!-- The second pane: its chat, and its panel at the outer edge
                 (the left one when stacked, like the main pane's). -->
            <div
                class="split-side flex min-w-0 min-h-0"
                class:h-full={!column}
                class:w-full={column}
                class:shrink-0={column}
                style:height={column ? `${$splitChatHeight}px` : undefined}
            >
                {#if docked && splitLayout.panelOpen.side && column}
                    <Sidebar part="panel" pane="side" hidden={false} {openLegacyGrid} />
                {/if}
                <!-- The width the divider sets is the chat's; its panel sits beside it. -->
                <div
                    class="split-side-chat flex h-full min-w-0"
                    class:grow={column}
                    style:flex-basis={column ? undefined : `${$splitChatWidth}px`}
                >
                    <SecondaryChatPanel />
                </div>
                {#if docked && splitLayout.panelOpen.side && !column}
                    <Sidebar part="panel" pane="side" hidden={false} {openLegacyGrid} />
                {/if}
            </div>
        {/if}
    </div>
    {#if docked && rail === 'end'}{@render botList()}{/if}
</div>

<style>
    .split-chat-divider {
        touch-action: none;
    }

    /* Side by side, the main pane keeps room for its chat; the second pane
       gives way first, down to a narrow chat. */
    .split-main-docked {
        flex: 1 1 0;
        min-width: 320px;
    }

    .split-side:not(.w-full) {
        flex: 0 1 auto;
    }

    .split-side-chat:not(.grow) {
        flex-grow: 0;
        flex-shrink: 1;
        min-width: 240px;
    }

    .split-chat-contained {
        /* User CSS often places chat controls with position:fixed. Paint
           containment gives the main pane its own fixed-position viewport,
           as the second pane has. */
        contain: paint;
        isolation: isolate;
        overflow: clip;
    }
</style>
