<script lang="ts">
    import { BotIcon, PackageIcon, Sailboat } from "@lucide/svelte";
    import { language } from "src/lang";
    import { QuickSettings } from "src/ts/stores.svelte";
    import { tooltip } from "src/ts/gui/tooltip";
    import BotSettings from "../Setting/Pages/BotSettings.svelte";
    import OtherBotSettings from "../Setting/Pages/OtherBotSettings.svelte";
    import ModuleSettings from "../Setting/Pages/Module/ModuleSettings.svelte";

    let activeIndex = $derived(QuickSettings.index);
</script>

<div class="mb-2 flex shrink-0 gap-2">
    <button
        class={activeIndex === 0 ? 'text-textcolor' : 'text-textcolor2'}
        aria-label={language.chatBot}
        use:tooltip={language.chatBot}
        onclick={() => {QuickSettings.index = 0}}
    >
        <BotIcon />
    </button>
    <button
        class={activeIndex === 1 ? 'text-textcolor' : 'text-textcolor2'}
        aria-label={language.otherBots}
        use:tooltip={language.otherBots}
        onclick={() => {QuickSettings.index = 1}}
    >
        <Sailboat />
    </button>
    <button
        class={activeIndex === 2 ? 'text-textcolor' : 'text-textcolor2'}
        aria-label={language.module}
        use:tooltip={language.module}
        onclick={() => {QuickSettings.index = 2}}
    >
        <PackageIcon />
    </button>
</div>

<div
    class="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6 text-textcolor rs-setting-cont-5"
>
    {#if activeIndex === 0}
        <BotSettings />
    {:else if activeIndex === 1}
        <OtherBotSettings />
    {:else}
        <ModuleSettings />
    {/if}
</div>
