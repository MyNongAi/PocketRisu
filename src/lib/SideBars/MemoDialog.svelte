<script lang="ts">
    // Private memos (the user's request, 2026-10-17): one per bot, shown in
    // all of its chats, and one per chat. PocketRisu-only fields
    // (nodeOnlyMemo): never read into a prompt, ignored by other Risu builds.
    // The bot memo lives on the character, the chat memo in the chat body;
    // both save with the usual save loop as they are typed.
    import { NotebookPenIcon, XIcon } from '@lucide/svelte'
    import type { character } from 'src/ts/storage/database.svelte'
    import { language } from 'src/lang'
    import { BackLayerRank, useBackLayer } from 'src/ts/gui/backLayers.svelte'

    let { chara = $bindable(), close }: { chara: character, close: () => void } = $props()

    const chat = $derived(chara.chats?.[chara.chatPage])
    useBackLayer(BackLayerRank.Popup, () => true, () => { close() })

    function closeFromBackdrop(event: MouseEvent) {
        if (event.target === event.currentTarget) close()
    }

    function closeFromKeyboard(event: KeyboardEvent) {
        if (event.key === 'Escape') close()
    }
</script>

<svelte:window onkeydown={closeFromKeyboard} />

<div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3 sm:p-6"
    role="presentation"
    onclick={closeFromBackdrop}
>
    <div
        class="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-xl border border-darkborderc bg-darkbg shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={language.memoTitle}
    >
        <div class="flex shrink-0 items-center gap-2 border-b border-darkborderc px-4 py-3 text-textcolor">
            <NotebookPenIcon size={18} class="text-textcolor2" />
            <h2 class="mt-0 mb-0 font-bold">{language.memoTitle}</h2>
            <div class="grow flex justify-end">
                <button type="button" aria-label={language.close} class="cursor-pointer text-textcolor2 hover:text-primary" onclick={close}>
                    <XIcon size={22} />
                </button>
            </div>
        </div>
        <div class="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
            <label class="flex flex-col gap-1">
                <span class="text-sm text-textcolor">{language.memoBot.replace('{}', chara.name || 'Unnamed')}</span>
                <textarea
                    class="risu-field-border min-h-28 resize-y rounded-md bg-transparent px-3 py-2 text-sm text-textcolor outline-none"
                    rows="5"
                    placeholder={language.memoBotPlaceholder}
                    value={chara.nodeOnlyMemo ?? ''}
                    oninput={(e) => { chara.nodeOnlyMemo = e.currentTarget.value }}
                ></textarea>
            </label>
            {#if chat && !chat._placeholder}
                <label class="flex flex-col gap-1">
                    <span class="text-sm text-textcolor">{language.memoChat.replace('{}', chat.name || '')}</span>
                    <textarea
                        class="risu-field-border min-h-28 resize-y rounded-md bg-transparent px-3 py-2 text-sm text-textcolor outline-none"
                        rows="5"
                        placeholder={language.memoChatPlaceholder}
                        value={chat.nodeOnlyMemo ?? ''}
                        oninput={(e) => { chat.nodeOnlyMemo = e.currentTarget.value }}
                    ></textarea>
                </label>
            {/if}
            <p class="text-xs text-textcolor2">{language.memoPrivateNote}</p>
        </div>
    </div>
</div>
