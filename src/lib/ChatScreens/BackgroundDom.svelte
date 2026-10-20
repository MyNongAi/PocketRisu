<script lang="ts">
    import { ParseMarkdown, risuChatParser } from "src/ts/parser/parser.svelte";
    import { type character } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { moduleBackgroundEmbedding, ReloadGUIPointer } from "src/ts/stores.svelte";
    import { getPaneView } from "src/ts/chatPanes.svelte";

    // The pane's bot (chatPanes.svelte.ts). The modules' background is worked
    // out for the selected chat only (moduleUpdate), so only its pane shows it.
    const view = getPaneView()
    let backgroundHTML = $derived(view.character?.backgroundHTML)
    let currentChar:character = $derived(view.character)
    let moduleBackground = $derived(view.active ? $moduleBackgroundEmbedding : '')

</script>


{#if backgroundHTML || moduleBackground}
    {#if view.characterIndex > -1}
        {#key $ReloadGUIPointer}
            <div class="absolute top-0 left-0 w-full h-full" data-pr-bot-background>
                {#await ParseMarkdown(risuChatParser((backgroundHTML || '') + '\n' + (moduleBackground || ''), {chara:currentChar}), currentChar, 'back') then md} 
                    {@html md}
                {/await}
            </div>
        {/key}
    {/if}
{/if}