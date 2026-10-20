<script lang="ts">
    import { ArrowLeft, ArrowRight } from "@lucide/svelte";
    import { DynamicGUI, MobileGUI, sideBarClosing, sideBarStore } from "src/ts/stores.svelte";
    import { isEmbeddedRisuPane, splitChatOpen } from "src/ts/chatSplitPane";
    import { getPaneView } from "src/ts/chatPanes.svelte";
    import { splitLayout, togglePanePanel } from "src/ts/splitLayout.svelte";
    import { language } from "src/lang";

    // In the docked split (SplitWorkspace) each pane's arrow opens and closes
    // its own character panel; the second pane's panel sits at its outer
    // (right) edge when the panes are side by side, so its arrow does too.
    const view = getPaneView()
    const docked = $derived($splitChatOpen && !$MobileGUI && !$DynamicGUI && !isEmbeddedRisuPane)
    const mirrored = $derived(docked && view.pane === 'side' && splitLayout.orientation === 'row')
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
