<script lang="ts">
    import { BotIcon, PackageIcon, Sailboat } from "@lucide/svelte";
    import { QuickSettings, selectedCharID } from "src/ts/stores.svelte";
    import BotSettings from "../Setting/Pages/BotSettings.svelte";
    import OtherBotSettings from "../Setting/Pages/OtherBotSettings.svelte";
    import ModuleSettings from "../Setting/Pages/Module/ModuleSettings.svelte";

    interface Props {
        modulesOnly?: boolean;
    }

    let { modulesOnly = false }: Props = $props();
    let activeIndex = $derived(modulesOnly ? 2 : QuickSettings.index);
</script>

{#if !modulesOnly}
<div class="mb-2 flex shrink-0 gap-2">
    {#if $selectedCharID >= 0}
        <button class={activeIndex === 0 ? 'text-textcolor ' : 'text-textcolor2'} onclick={() => {QuickSettings.index = 0}}>
            <BotIcon />
        </button>
        <button class={activeIndex === 1 ? 'text-textcolor ' : 'text-textcolor2'} onclick={() => {QuickSettings.index = 1}}>
            <Sailboat />
        </button>
    {/if}
    <button class={activeIndex === 2 ? 'text-textcolor ' : 'text-textcolor2'} onclick={() => {QuickSettings.index = 2}}>
        <PackageIcon />
    </button>
</div>
{/if}

<div
    class="relative flex min-h-0 flex-1 flex-col px-4 py-6 text-textcolor rs-setting-cont-5"
    class:overflow-y-auto={activeIndex !== 2}
    class:overflow-y-hidden={activeIndex === 2}
>
    {#if activeIndex === 0 && $selectedCharID >= 0}
        <BotSettings />
    {:else if activeIndex === 1 && $selectedCharID >= 0}
        <OtherBotSettings />
    {:else}
        <ModuleSettings quickPanel />
    {/if}
</div>
