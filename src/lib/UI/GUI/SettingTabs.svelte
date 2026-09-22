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
</script>

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

<style>
    .setting-tabs {
        scrollbar-width: none;
        -ms-overflow-style: none;
    }
    .setting-tabs::-webkit-scrollbar {
        display: none;
    }
</style>
