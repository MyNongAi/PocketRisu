<script lang="ts">
    import { onDestroy, untrack } from "svelte";
    import { ParseMarkdown, risuChatParser } from "src/ts/parser/parser.svelte";
    import { type character } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { moduleBackgroundEmbedding, ReloadGUIPointer } from "src/ts/stores.svelte";
    import { getPaneView, selectedChatIds } from "src/ts/chatPanes.svelte";
    import { paneMayRedraw, PaneRedrawGate } from "src/ts/gui/paneRedraw";
    import { LatestBackground } from "src/ts/gui/backgroundRender";
    import { backgroundGate } from "src/ts/gui/backgroundGate.svelte";

    // The pane's bot (chatPanes.svelte.ts). The modules' background is worked
    // out for the selected chat only (moduleUpdate), so only its pane shows it.
    const view = getPaneView()
    // SPLIT-PANE-ISOLATION (2026-11-25): global redraws cannot reparse the other chat's background.
    const redrawGate = new PaneRedrawGate()
    let effectiveReload = $state(0)
    let previousReload = $ReloadGUIPointer
    $effect(() => {
        const incoming = $ReloadGUIPointer
        const active = view.active
        const chatId = view.chat?.id
        const selectedId = untrack(() => selectedChatIds()?.chatId)
        const allowed = paneMayRedraw(active, chatId, selectedId)
        if (incoming !== previousReload) {
            previousReload = incoming
            if (redrawGate.signal(allowed)) effectiveReload = redrawGate.revision
        } else if (redrawGate.catchUp(allowed)) effectiveReload = redrawGate.revision
    })
    let backgroundHTML = $derived(view.character?.backgroundHTML)
    let currentChar:character = $derived(view.character)
    let moduleBackground = $derived(view.active ? $moduleBackgroundEmbedding : '')
    // The pane beside the selection parses with its own chat ({{getvar}}).
    // The selected pane passes none, as before: reading the chat there rebuilt
    // the background each time a send replaced the chat object.

    // A redraw keeps the last background of the same bot until the new one is
    // parsed, as message bodies do: emptied meanwhile ({#key} over {#await}),
    // panels styled by its <style> showed as plain text (backgroundRender.ts).
    let shown = $state('')
    // Entering a bot with a <style> in its background, this pane's message
    // bodies wait for it (backgroundGate.svelte.ts).
    const gate = backgroundGate(view)
    let styled = false
    const background = new LatestBackground((html) => { shown = html }, (waiting) => { gate.waiting = waiting && styled })
    $effect(() => {
        effectiveReload
        if (!(backgroundHTML || moduleBackground) || view.characterIndex < 0) {
            background.clear()
            return
        }
        const source = (backgroundHTML || '') + '\n' + (moduleBackground || '')
        const char = currentChar
        const chat = view.active ? undefined : view.chat
        styled = /<style/i.test(source)
        // An inactive background's app-wide parser reads are a snapshot until its own redraw.
        const parse = () => ParseMarkdown(risuChatParser(source, {chara:char, chat}), char, 'back')
        background.render(char?.chaId, () => view.active ? parse() : untrack(parse))
    })
    onDestroy(() => background.stop())

</script>


{#if backgroundHTML || moduleBackground}
    {#if view.characterIndex > -1}
        <div class="absolute top-0 left-0 w-full h-full" data-pr-bot-background>
            {@html shown}
        </div>
    {/if}
{/if}
