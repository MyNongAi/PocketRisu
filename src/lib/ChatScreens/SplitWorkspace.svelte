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
    import { DBState, DynamicGUI, MobileGUI, settingsOpen } from 'src/ts/stores.svelte'
    import { clampSplitHeight, clampSplitWidth, dockedSplitChatRoom, dockedSplitWidths, getSplitWidthBounds, isEmbeddedRisuPane, looseSplitSideWidth, NARROW_SPLIT_PX, paneOverlayFootprint, paneOverlayRailRem, SPLIT_DIVIDER_PX, SPLIT_MAIN_CHAT_MIN_PX, splitChatHeight, splitChatOpen, splitChatWidth, type DockedSplitRow } from 'src/ts/chatSplitPane'
    import SecondaryChatPanel from './SecondaryChatPanel.svelte'
    import Sidebar from '../SideBars/Sidebar.svelte'
    import { restorePanesAfterBoot, returnToMainPane, swapPanes } from 'src/ts/paneActivation'
    import { startPaneSync } from 'src/ts/chatPanes.svelte'
    import { paneOverlayOpen, railPlace, setPaneOverlayOpen, setSplitLayout, splitLayout, type RailPlace } from 'src/ts/splitLayout.svelte'
    import { alertSelect, type AlertAction } from 'src/ts/alert'
    import { setSidebarCatalogSplit, sidebarCatalog } from 'src/ts/gui/sidebarCatalogLayout.svelte'
    import { language } from 'src/lang'

    let { children, openLegacyGrid = () => {} }: { children: Snippet, openLegacyGrid?: () => void } = $props()

    const enabled = $derived($splitChatOpen && !$MobileGUI && !isEmbeddedRisuPane)
    // The docked layout. A narrow (DynamicGUI) window lays each pane's
    // sidebar over that pane's chat instead (paneOverlayOpen), so both panes
    // can show their own at once (the user's request, 2026-10-21).
    const docked = $derived(enabled && !$DynamicGUI)
    const mainOverlayShown = $derived(enabled && !docked && paneOverlayOpen.main && !$settingsOpen)
    const sideOverlayShown = $derived(enabled && !docked && paneOverlayOpen.side)
    // Leaving the narrow layout (or the split) closes them; they are not kept.
    $effect(() => {
        if (enabled && !docked) return
        untrack(() => { setPaneOverlayOpen('main', false); setPaneOverlayOpen('side', false) })
    })
    // The two panes and the divider between them (the bot list sits outside it at the ends).
    let paneRoot: HTMLDivElement | null = $state(null)
    let paneWidth = $state(0)
    // A window too narrow for two chats side by side (a folded phone with the
    // mobile layout off) stacks them, as the docked split's "위아래로" does
    // (the page ran 150px past the screen at 375px, 2026-10-21).
    const narrowStack = $derived(enabled && !docked && paneWidth > 0 && paneWidth < NARROW_SPLIT_PX)
    const column = $derived((docked && splitLayout.orientation === 'column') || narrowStack)
    const rail = $derived(railPlace())
    // The bot list can be put away for room (the divider's menu).
    const railShown = $derived(!splitLayout.railHidden)
    $effect(() => {
        if (!enabled) returnToMainPane()
    })
    // Stacking keeps the lower pane's height within the window.
    $effect(() => {
        if (!column || !paneRoot) return
        untrack(() => splitChatHeight.update((height) => clampSplitHeight(height, columnRoom())))
    })
    onMount(() => {
        const stopSync = startPaneSync()
        // After bootstrap's own restore of the last chat (100 ms after load).
        const restore = setTimeout(() => { if (enabled) restorePanesAfterBoot() }, 400)
        return () => { stopSync(); clearTimeout(restore) }
    })
    let railWidth = $state(0)
    let stopSplitResize: (() => void) | null = null

    const mainPanelShown = $derived(docked && splitLayout.panelOpen.main && !$settingsOpen)
    const sidePanelShown = $derived(docked && splitLayout.panelOpen.side)
    const dockedRowAt = (span: number): DockedSplitRow => ({ span, rail: railShown && rail === 'center' ? railWidth : 0, mainPanel: mainPanelShown, sidePanel: sidePanelShown })
    // Side by side, the widths are set here, so the main chat keeps its
    // minimum and the second pane gives way first (dockedSplitWidths).
    const dockedRow = $derived(docked && !column ? dockedSplitWidths(dockedRowAt(paneWidth || window.innerWidth), $splitChatWidth) : null)
    // A narrow window side by side: the second pane's own width, both chats
    // keeping their minimum (its chat alone held 240px, and its box shrank
    // below that, so the page ran past the screen; 2026-10-21).
    const looseSide = $derived(enabled && !docked && !column ? looseSplitSideWidth(paneWidth || window.innerWidth, $splitChatWidth) : null)
    // Side by side in a narrow window, the second pane's own window would
    // leave its panel under 200px at the pane's narrowest (320px): it reaches
    // over the divider up to the app sidebar's width (26rem), but leaves the
    // main pane's open window its closing strip (Sidebar: bot list 5rem or
    // two columns' 10rem, panel up to 24rem, strip 3rem). Null: just the pane
    // (stacked).
    const sideOverlayWidth = $derived.by(() => {
        if (looseSide === null) return null
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
        const main = (paneWidth || window.innerWidth) - SPLIT_DIVIDER_PX - looseSide
        const mainOverlay = paneOverlayFootprint(main, paneOverlayRailRem(sidebarCatalog.split, !!DBState.db.menuSideBar), rem)
        const spare = paneOverlayOpen.main ? Math.max(0, main - mainOverlay) : main
        return Math.max(looseSide, Math.min(26 * rem, looseSide + SPLIT_DIVIDER_PX + spare))
    })
    // The room the two chats share: no divider, and docked, no bot list
    // between the panes and no open panels. Docked, the wide end leaves the
    // main chat its minimum.
    const rowSpan = () => paneRoot?.clientWidth ?? window.innerWidth
    const rowRoom = (span: number) => docked ? dockedSplitChatRoom(dockedRowAt(span)) : Math.max(0, span - SPLIT_DIVIDER_PX)
    const columnRoom = () => Math.max(0, (paneRoot?.clientHeight ?? window.innerHeight) - SPLIT_DIVIDER_PX)
    const mainMinimum = SPLIT_MAIN_CHAT_MIN_PX
    const widthBounds = $derived(getSplitWidthBounds(rowRoom(paneWidth), mainMinimum))
    const clampWidth = (width: number) => clampSplitWidth(width, rowRoom(rowSpan()), mainMinimum)
    const clampSize = (size: number) => column ? clampSplitHeight(size, columnRoom()) : clampWidth(size)
    const setSize = (size: number) => (column ? splitChatHeight : splitChatWidth).set(clampSize(size))
    // The size on screen: docked side by side, the second chat can be narrower than the width saved.
    const shownSize = () => column ? $splitChatHeight : (dockedRow?.sideChat ?? looseSide ?? $splitChatWidth)

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
        const startSize = shownSize()
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

    // Even: the two chats get the same, unless the main chat would go under its minimum.
    function resetSplitSize() {
        setSize((column ? columnRoom() : rowRoom(rowSpan())) / 2)
    }

    function handleSplitDividerKeydown(event: KeyboardEvent) {
        const step = event.shiftKey ? 80 : 24
        const size = shownSize()
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

    // One divider menu at a time: a touch long press can bring both the press
    // timer and the browser's own contextmenu (Chrome on Android, Windows
    // touch), and a second question replaces the first and comes back after it.
    let dividerMenuOpen = false

    async function openDividerMenu(event?: MouseEvent) {
        event?.preventDefault()
        // The contextmenu of a press still held: the press neither opens the menu again nor resizes.
        stopSplitResize?.()
        if (!docked || dividerMenuOpen) return
        dividerMenuOpen = true
        try {
            await askDividerMenu()
        } finally {
            dividerMenuOpen = false
        }
    }

    // Choices of one kind on one line (the user's request, 2026-10-22): where
    // the bot list goes, the current place marked; putting it away; the panes.
    // Even widths are a double-click on the divider (no menu item, as asked).
    async function askDividerMenu() {
        const row = splitLayout.orientation === 'row'
        const hidden = splitLayout.railHidden
        const railChoices: [RailPlace, string][] = row
            ? [['start', language.splitRailStart], ['center', language.splitRailCenter], ['end', language.splitRailEnd]]
            : [['start', language.splitRailStart], ['end', language.splitRailEnd]]
        const actions: [AlertAction, () => void][] = [
            ...railChoices.map(([place, label]): [AlertAction, () => void] => [
                { label, row: 'rail', variant: !hidden && place === rail ? 'primary' : 'outline' },
                () => setSplitLayout({ railAt: place, railHidden: false }),
            ]),
            // One column or two (the user's request, 2026-10-22), as in the bot list's + menu.
            ...([[false, language.splitRailOneColumn], [true, language.splitRailTwoColumns]] as const).map(([split, label]): [AlertAction, () => void] => [
                { label, row: 'columns', variant: sidebarCatalog.split === split ? 'primary' : 'outline' },
                () => { setSidebarCatalogSplit(split); setSplitLayout({ railHidden: false }) },
            ]),
            [{ label: hidden ? language.splitRailShow : language.splitRailHide }, () => setSplitLayout({ railHidden: !hidden })],
            [{ label: row ? language.splitSwapRow : language.splitSwapColumn, row: 'panes' }, () => swapPanes()],
            [{ label: row ? language.splitToColumn : language.splitToRow, row: 'panes' }, () => setSplitLayout({ orientation: row ? 'column' : 'row' })],
        ]
        const selected = parseInt(await alertSelect([...actions.map(([action]) => action), language.cancel]))
        actions[selected]?.[1]()
    }

    onDestroy(() => {
        stopSplitResize?.()
    })
    onMount(() => {
        const clampStoredSizes = () => {
            if (!paneRoot) return
            // Docked, the layout narrows what it shows (dockedSplitWidths), so
            // the saved width comes back once the window is wide again.
            if (!docked) splitChatWidth.update(clampWidth)
            if (column) splitChatHeight.update((height) => clampSplitHeight(height, columnRoom()))
        }
        clampStoredSizes()
        window.addEventListener('resize', clampStoredSizes)
        return () => window.removeEventListener('resize', clampStoredSizes)
    })
</script>

{#snippet botList()}
    <div class="split-rail flex h-full shrink-0" bind:clientWidth={railWidth}>
        <Sidebar part="rail" hidden={false} {openLegacyGrid} />
    </div>
{/snippet}

<div class="flex h-full w-full min-w-0">
    {#if docked && railShown && rail === 'start'}{@render botList()}{/if}
    <div class="flex h-full min-w-0 grow" class:flex-col={column} bind:this={paneRoot} bind:clientWidth={paneWidth}>
        <!-- The main pane: its panel, then the main content (chat or settings).
             Contained while split, so user CSS with position:fixed stays inside it. -->
        <div
            class="split-main relative flex min-w-0 min-h-0 grow"
            class:h-full={!column}
            class:split-chat-contained={enabled}
            class:split-main-docked={!!dockedRow}
            style:--split-panel={dockedRow ? `${dockedRow.mainPanel}px` : undefined}
        >
            {#if mainPanelShown}
                <Sidebar part="panel" pane="main" hidden={false} {openLegacyGrid} />
            {/if}
            <div class="relative flex h-full min-w-0 grow">
                {@render children()}
            </div>
            {#if mainOverlayShown}
                <div class="split-pane-overlay absolute inset-0 z-30 flex overflow-hidden">
                    <Sidebar pane="main" overlay hidden={false} {openLegacyGrid} />
                </div>
            {/if}
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
                aria-valuemin={column ? 0 : widthBounds.min}
                aria-valuemax={column ? (paneRoot?.clientHeight ?? 0) : widthBounds.max}
                aria-valuenow={column ? $splitChatHeight : (dockedRow?.sideChat ?? looseSide ?? $splitChatWidth)}
                title={docked ? language.splitDividerLabel : undefined}
                tabindex="0"
                onpointerdown={beginSplitResize}
                ondblclick={resetSplitSize}
                onkeydown={handleSplitDividerKeydown}
                oncontextmenu={openDividerMenu}
            ></div>
            {#if docked && railShown && rail === 'center'}{@render botList()}{/if}
            <!-- The second pane: its chat, and its panel at the outer edge
                 (the left one when stacked, like the main pane's). -->
            <div
                class="split-side relative flex min-w-0 min-h-0"
                class:h-full={!column}
                class:w-full={column}
                class:shrink-0={column}
                class:split-side-fixed={looseSide !== null}
                class:split-side-docked={!!dockedRow}
                style:height={column ? `${$splitChatHeight}px` : undefined}
                style:width={dockedRow ? `${dockedRow.sideChat + dockedRow.sidePanel}px` : looseSide !== null ? `${looseSide}px` : undefined}
                style:--split-panel={dockedRow ? `${dockedRow.sidePanel}px` : undefined}
            >
                {#if sidePanelShown && column}
                    <Sidebar part="panel" pane="side" hidden={false} {openLegacyGrid} />
                {/if}
                <!-- The width the divider sets is the chat's; its panel sits beside it. -->
                <div
                    class="split-side-chat flex h-full min-w-0"
                    class:grow={column}
                    style:flex-basis={column ? undefined : `${dockedRow?.sideChat ?? looseSide ?? $splitChatWidth}px`}
                >
                    <SecondaryChatPanel />
                </div>
                {#if sidePanelShown && !column}
                    <Sidebar part="panel" pane="side" hidden={false} {openLegacyGrid} />
                {/if}
                {#if sideOverlayShown}
                    <div
                        class="split-pane-overlay absolute inset-y-0 right-0 z-30 flex overflow-hidden"
                        style:width={sideOverlayWidth === null ? '100%' : `${sideOverlayWidth}px`}
                    >
                        <Sidebar pane="side" overlay hidden={false} {openLegacyGrid} />
                    </div>
                {/if}
            </div>
        {/if}
    </div>
    {#if docked && railShown && rail === 'end'}{@render botList()}{/if}
</div>

<style>
    .split-chat-divider {
        touch-action: none;
    }

    /* Docked side by side, the widths come from dockedSplitWidths
       (chatSplitPane.ts): the second chat and the open panels get theirs,
       the main chat takes the rest and keeps its minimum. */
    .split-main-docked {
        flex: 1 1 0;
    }

    .split-side:not(.w-full) {
        flex: 0 1 auto;
    }

    .split-side.split-side-docked,
    .split-side.split-side-fixed {
        flex: none;
    }

    .split-side-chat:not(.grow) {
        flex-grow: 0;
        flex-shrink: 1;
        min-width: 240px;
    }

    .split-side-docked > .split-side-chat {
        flex-shrink: 0;
        min-width: 0;
    }

    /* The panels' w-80 narrows on a tight window. */
    .split-main-docked > :global([data-pane-panel]),
    .split-side-docked > :global([data-pane-panel]) {
        flex: none;
        width: var(--split-panel);
        min-width: var(--split-panel);
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
