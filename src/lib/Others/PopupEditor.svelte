<script lang="ts">
    import { DBState, isTouchDevice, popUpEditorStore } from '../../ts/stores.svelte';
    import { get } from 'svelte/store';
    import type MonacoEditorType from './MonacoEditor.svelte';
    import { language } from 'src/lang';
    import { risuChatParser } from "src/ts/parser/parser.svelte";
    import { tokenize } from 'src/ts/tokenizer';
    import Toggles from '../SideBars/Toggles.svelte';
    import { getCurrentCharacter } from 'src/ts/storage/database.svelte';

    let languageMode = $state(popUpEditorStore.language || 'markdown');
    let previewing = $state(false);
    let tokens = $state(0);
    let MonacoComponent: (typeof MonacoEditorType)|null = $state(null)
    let showToggles = $state(false)

    let chatParserValue = $derived.by(() => {
        if(!previewing){
            return ''
        }

        try {
            $state.snapshot(DBState.db.globalChatVariables)
        } catch (error) {

        }
        return risuChatParser(popUpEditorStore.value)
    })

    $effect(() => {
        if(!previewing){
            return
        }
        tokenize(chatParserValue).then((toks) => {
            tokens = toks
        }).catch(() => {
            tokens = 0
        })
    })

    // The code editor (Monaco) does not take touch selection: a drag scrolls
    // and a long press opens its line menu, so a phone could not select an
    // arbitrary range (the user's report, 2026-10-17). A plain textarea gets
    // the phone's own selection handles. Plain is the default on a touch
    // screen; the header switches, and the choice is remembered.
    const PLAIN_KEY = 'pocketrisu:popup-editor-plain'
    function readPlain(): boolean {
        try {
            const stored = localStorage.getItem(PLAIN_KEY)
            if (stored === '1') return true
            if (stored === '0') return false
        } catch {
            // default below
        }
        return get(isTouchDevice)
    }
    let plain = $state(readPlain())
    function togglePlain() {
        plain = !plain
        try { localStorage.setItem(PLAIN_KEY, plain ? '1' : '0') } catch { /* this time only */ }
    }

    $effect(() => {
        if (plain || MonacoComponent) return
        import('./MonacoEditor.svelte').then((module) => {
            MonacoComponent = module.default;
        });
    });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="fixed top-0 left-0 w-full h-full bg-black/50 backdrop-blur-sm flex items-center justify-center z-50"
    onclick={() => (popUpEditorStore.open = false)}
>
    <div
        class="bg-darkbg rounded-lg p-4 w-11/12 h-11/12 flex flex-col gap-2"
        onclick={(e) => e.stopPropagation()}
    >
         <!-- Header Toolbar -->
         <div class="flex items-center justify-between">
            <h2 class="text-xl font-bold">Popup Editor</h2>
            <div class="flex items-center gap-2">
                {#if ['markdown', 'cbs'].includes(languageMode)}
                    {#if !previewing}
                        <select
                            bind:value={languageMode}
                            class="bg-bgcolor border-none rounded px-2 py-1 text-sm"
                        >
                            <option value="markdown">Markdown</option>
                            <option value="cbs" disabled>CBS</option>
                        </select>
                    {/if}
                    <button
                        class="bg-primary text-white px-3 py-1 rounded hover:bg-primary/90 transition"
                        onclick={() => (previewing = !previewing)}
                    >
                        {previewing ? language.edit : language.preview}
                    </button>
                {:else}
                    <span class="bg-bgcolor border-none rounded px-2 py-1 text-sm">{languageMode}</span>
                {/if}
                {#if !previewing}
                    <button
                        class="bg-bgcolor px-3 py-1 rounded text-sm hover:bg-selected transition"
                        onclick={togglePlain}
                        title={plain ? language.popupEditorUseCode : language.popupEditorUsePlain}
                    >{plain ? language.popupEditorUseCode : language.popupEditorUsePlain}</button>
                {/if}
                <button
                    class="bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600 transition"
                    onclick={() => (popUpEditorStore.open = false)}
                >
                    X
                </button>
            </div>
        </div>
        <div class="flex-1 rounded-md overflow-hidden border border-darkborderc">
            {#if previewing}
                <div class="h-full w-full flex">
                    <div class="flex-1 flex flex-col gap-4 overflow-hidden">
                        <div class="flex-1 overflow-y-auto overflow-x-auto max-w-full border border-darkborderc bg-bgcolor p-4">
                            <pre class="m-0">{chatParserValue}</pre>
                        </div>

                        <div class="text-sm p-4 text-gray-500 flex overflow-x-auto">
                            <button class={{
                                "bg-primary text-white hover:bg-primary/90": showToggles,
                                "bg-gray-500 text-white hover:bg-gray-600": !showToggles,
                                "px-3 py-1 rounded transition": true,
                            }} onclick={() => {
                                showToggles = !showToggles
                            }}>Toggles</button>
                            <span class="ml-auto">{tokens} tokens</span>
                        </div>
                    </div>
                    {#if showToggles}
                        <div class="w-64 border-l border-darkborderc overflow-y-auto p-2">
                            <Toggles chara={getCurrentCharacter()} />
                        </div>
                    {/if}
                </div>
            {:else if plain}
                <textarea
                    class="block h-full w-full resize-none bg-bgcolor p-3 font-mono text-sm text-textcolor outline-none"
                    spellcheck="false"
                    autocomplete="off"
                    bind:value={popUpEditorStore.value}
                ></textarea>
            {:else}
                {#if MonacoComponent}
                    <MonacoComponent bind:value={popUpEditorStore.value} language={languageMode} />
                {/if}
            {/if}
        </div>
    </div>
</div>
