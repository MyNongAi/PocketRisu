<script lang="ts">
    import { ArrowLeft, ArrowRight } from "@lucide/svelte";
    import { DynamicGUI, MobileGUI, sideBarClosing, sideBarStore } from "src/ts/stores.svelte";
    import { isEmbeddedRisuPane, splitChatOpen } from "src/ts/chatSplitPane";
    import { getPaneView } from "src/ts/chatPanes.svelte";
    import { setPaneOverlayOpen, splitLayout, togglePanePanel } from "src/ts/splitLayout.svelte";
    import { language } from "src/lang";

    // In the split each pane's arrow opens its own character panel. Docked
    // (SplitWorkspace) it opens and closes it beside the chat; in a narrow
    // window it opens the panel over this pane's chat, and the panel closes
    // itself. The arrow sits at the edge the panel comes out of
    // (splitLayout.panelEdge: the right pane's at the right unless changed).
    const view = getPaneView()
    const split = $derived($splitChatOpen && !$MobileGUI && !isEmbeddedRisuPane)
    const docked = $derived(split && !$DynamicGUI)
    const mirrored = $derived(split && splitLayout.panelEdge[view.pane] === 'end')
    const panelOpen = $derived(splitLayout.panelOpen[view.pane])
</script>

{#if !$MobileGUI}
    {#if docked}
        <button
            onclick={() => togglePanePanel(view.pane)}
            aria-label={language.splitPanelToggle}
            title={language.splitPanelToggle}
            class={`absolute top-3 h-12 w-12 border-b border-t bg-darkbg hover:border-neutral-200 transition-colors flex items-center justify-center text-textcolor z-20 ${mirrored ? 'right-0 rounded-l-md border-l' : 'left-0 rounded-r-md border-r'} ${panelOpen ? 'border-transparent' : 'border-borderc opacity-50 hover:opacity-90'}`}
        >
            {#if panelOpen !== mirrored}<ArrowLeft />{:else}<ArrowRight />{/if}
        </button>
    {:else if split}
        <button
            onclick={() => setPaneOverlayOpen(view.pane, true)}
            aria-label={language.splitPanelToggle}
            title={language.splitPanelToggle}
            class={`absolute top-3 h-12 w-12 border-b border-t border-borderc bg-darkbg hover:border-neutral-200 transition-colors flex items-center justify-center text-textcolor opacity-50 hover:opacity-90 z-20 ${mirrored ? 'right-0 rounded-l-md border-l' : 'left-0 rounded-r-md border-r'}`}
        >
            {#if mirrored}<ArrowLeft />{:else}<ArrowRight />{/if}
        </button>
    {:else if $sideBarStore && !$DynamicGUI}
        <button onclick={() => {sideBarClosing.set(true)}} class="absolute top-3 left-0 h-12 w-12 border-r border-b border-t border-transparent  rounded-r-md bg-darkbg hover:border-neutral-200 transition-colors flex items-center justify-center text-textcolor z-20">
            <ArrowLeft />
        </button>
    {:else}
        <button onclick={() => {
            sideBarClosing.set(false);
            sideBarStore.set(true)}} class="absolute top-3 left-0 h-12 w-12 border-r border-b border-t border-borderc rounded-r-md bg-darkbg hover:border-neutral-200 transition-colors flex items-center justify-center text-textcolor opacity-50 hover:opacity-90 z-20">
            <ArrowRight />
        </button>
    {/if}
{/if}
