<script lang="ts">
    import { BotIcon, PackageIcon, Sailboat } from "@lucide/svelte";
    import { language } from "src/lang";
    import { QuickSettings, selectedCharID } from "src/ts/stores.svelte";
    import { tooltip } from "src/ts/gui/tooltip";
    import BotSettings from "../Setting/Pages/BotSettings.svelte";
    import OtherBotSettings from "../Setting/Pages/OtherBotSettings.svelte";
    import ModuleSettings from "../Setting/Pages/Module/ModuleSettings.svelte";

    interface Props {
        canEditCharacter?: boolean;
        onCharacterRequired?: () => void;
    }

    let {
        canEditCharacter = $selectedCharID >= 0,
        onCharacterRequired = () => {},
    }: Props = $props();
    let activeIndex = $derived(canEditCharacter ? QuickSettings.index : 2);

    function openCharacterSettings(index: 0 | 1) {
        if(!canEditCharacter){
            onCharacterRequired();
            return;
        }
        QuickSettings.index = index;
    }
</script>

<div class="mb-2 flex shrink-0 gap-2">
    <button
        class={activeIndex === 0 ? 'text-textcolor' : 'text-textcolor2'}
        class:opacity-50={!canEditCharacter}
        aria-label={language.chatBot}
        aria-disabled={!canEditCharacter}
        use:tooltip={language.chatBot}
        onclick={() => openCharacterSettings(0)}
    >
        <BotIcon />
    </button>
    <button
        class={activeIndex === 1 ? 'text-textcolor' : 'text-textcolor2'}
        class:opacity-50={!canEditCharacter}
        aria-label={language.otherBots}
        aria-disabled={!canEditCharacter}
        use:tooltip={language.otherBots}
        onclick={() => openCharacterSettings(1)}
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
    class="relative flex min-h-0 flex-1 flex-col px-4 py-6 text-textcolor rs-setting-cont-5"
    class:overflow-y-auto={activeIndex !== 2}
    class:overflow-y-hidden={activeIndex === 2}
>
    {#if activeIndex === 0 && canEditCharacter}
        <BotSettings />
    {:else if activeIndex === 1 && canEditCharacter}
        <OtherBotSettings />
    {:else}
        <ModuleSettings quickPanel />
    {/if}
</div>
