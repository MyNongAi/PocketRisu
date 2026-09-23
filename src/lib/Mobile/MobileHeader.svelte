<script lang="ts">
    import { ArrowLeft, MenuIcon, RotateCwIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    
    import { DBState } from 'src/ts/stores.svelte';
    import { MobileGUIStack, MobileSearch, selectedCharID, SettingsMenuIndex, MobileSideBar } from "src/ts/stores.svelte";
    import { SettingsRoute } from "src/ts/routing";
    import { deselectCharacter } from "src/ts/characters";
    import { isInStandaloneMode } from "src/ts/platform";
    import { reloadApp } from "src/ts/reloadApp";

    // An installed app has no browser reload button, and reloading is also
    // how it picks up a new build.
    let reloading = $state(false)
    async function reload() {
        if (reloading) return
        reloading = true
        try {
            if (!await reloadApp()) reloading = false
        } catch {
            reloading = false
        }
    }

</script>
<div class="w-full px-4 h-16 border-b border-b-darkborderc bg-darkbg flex justify-start items-center gap-2">
    {#if $selectedCharID !== -1 && $MobileSideBar > 0}
        <button onclick={() => {
            MobileSideBar.set(0)
        }}>
            <ArrowLeft />
        </button>
        <span class="font-bold text-lg w-2/3 truncate">{language.menu}</span>
    {:else if $selectedCharID !== -1}
        <button onclick={() => {
            deselectCharacter()
        }}>
            <ArrowLeft />
        </button>
        <span class="font-bold text-lg w-2/3 truncate">{DBState.db.characters[$selectedCharID].name}</span>
        <div class="flex-1 flex justify-end">
            <button onclick={() => {
                MobileSideBar.set(1)
            }}>
                <MenuIcon />
            </button>
        </div>
    {:else if $MobileGUIStack === 2 && $SettingsMenuIndex > -1}
        <button onclick={() => {
            SettingsMenuIndex.set(SettingsRoute.None)
        }}>
            <ArrowLeft />
        </button>
        <span class="font-bold text-lg">PocketRisu</span>
    {:else if $MobileGUIStack === 1}
        <div class="flex items-stretch w-2xl max-w-full">
            <input placeholder={language.search + '...'} bind:value={$MobileSearch} class="peer focus:border-textcolor transition-colors outline-hidden text-textcolor p-2 min-w-0 border bg-transparent rounded-md input-text text-xl grow mx-4 border-darkborderc resize-none overflow-y-hidden overflow-x-hidden max-w-full">
        </div>
    {:else}
        <span class="font-bold text-lg">PocketRisu</span>

    {/if}
    {#if isInStandaloneMode}
        <button
            class="ml-auto shrink-0 p-1 text-textcolor2 hover:text-textcolor disabled:opacity-50"
            aria-label={language.reloadApp}
            title={language.reloadApp}
            disabled={reloading}
            onclick={reload}
        >
            <RotateCwIcon size={20} class={reloading ? 'animate-spin' : ''} />
        </button>
    {/if}
</div>