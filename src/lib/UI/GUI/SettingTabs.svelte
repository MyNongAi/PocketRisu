<script lang="ts" module>
    import { getContext, setContext } from "svelte";

    const BOXED_TABS = Symbol("setting-tabs-boxed");

    /**
     * Sub-tabs under this component draw as the official client's boxed
     * buttons (equal widths) instead of the underline strip. Labels wrap only
     * at spaces (keep-all), so a narrow box shows "정규식 / 스크립트" rather
     * than breaking inside a word. The Ctrl+Q side panel uses it; the
     * settings page keeps the strip.
     */
    export function useBoxedSettingTabs() {
        setContext(BOXED_TABS, true);
    }
</script>

<script lang="ts">
    interface Tab {
        label: string;
        value: number;
    }

    let {
        tabs,
        selected = $bindable(0),
        sticky = false,
        onSelect = () => {},
    }: {
        tabs: Tab[];
        selected?: number;
        sticky?: boolean;
        onSelect?: (value: number) => void;
    } = $props();

    const boxed = getContext<boolean | undefined>(BOXED_TABS) === true;
</script>

{#if boxed}
<div class="flex w-full shrink-0 overflow-hidden rounded-md border border-darkborderc mb-4"
    class:sticky={sticky} class:top-0={sticky} class:z-20={sticky} class:bg-bgcolor={sticky}
    role="tablist">
    {#each tabs as tab, i}
        <button
            role="tab"
            aria-selected={selected === tab.value}
            class="min-h-10 min-w-0 flex-1 px-1 py-2 text-[13px] leading-tight break-keep wrap-break-word transition-colors
                {i < tabs.length - 1 ? 'border-r border-darkborderc' : ''}
                {selected === tab.value
                    ? 'bg-darkbutton text-textcolor'
                    : 'text-textcolor2 hover:bg-selected/30 hover:text-textcolor'}"
            onclick={() => {
                selected = tab.value
                onSelect(tab.value)
            }}
        >{tab.label}</button>
    {/each}
</div>
{:else}
<div class="setting-tabs flex w-full shrink-0 border-b border-darkborderc mb-4 overflow-x-auto"
    class:sticky={sticky} class:top-0={sticky} class:z-20={sticky} class:bg-bgcolor={sticky}
    role="tablist">
    {#each tabs as tab}
        <button
            role="tab"
            aria-selected={selected === tab.value}
            class="relative px-4 py-2 text-sm whitespace-nowrap shrink-0 transition-colors
                {selected === tab.value
                    ? 'text-textcolor'
                    : 'text-textcolor2 hover:text-textcolor'}"
            onclick={() => {
                selected = tab.value
                onSelect(tab.value)
            }}
        >
            {tab.label}
            {#if selected === tab.value}
                <span class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary"></span>
            {/if}
        </button>
    {/each}
</div>
{/if}

<style>
    .setting-tabs {
        scrollbar-width: none;
        -ms-overflow-style: none;
    }
    .setting-tabs::-webkit-scrollbar {
        display: none;
    }
</style>
