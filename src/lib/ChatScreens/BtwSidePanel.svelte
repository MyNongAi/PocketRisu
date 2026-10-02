<script lang="ts">
    // BTW side chat panel: out-of-character questions about the open chat.
    // A sheet over the lower chat area on narrow screens, a right side panel
    // from the md breakpoint. Nothing here writes to the chat; see
    // src/ts/process/btwSideChat.svelte.ts.
    import { MessageCircleQuestionMarkIcon, SendIcon, SquareIcon, TextCursorInputIcon, Trash2Icon, XIcon } from '@lucide/svelte'
    import { tick } from 'svelte'
    import { language } from 'src/lang'
    import { DBState } from 'src/ts/stores.svelte'
    import { isMobile } from 'src/ts/platform'
    import { isSendKey } from 'src/ts/gui/sendKey'
    import type { character as CharacterData, Chat } from 'src/ts/storage/database.svelte'
    import { BTW_LIMITS } from 'src/ts/process/btwSideChat'
    import { askBtw, btwChatKey, clearBtw, closeBtwPanel, ensureBtwChat, getBtwChatState, stopBtw } from 'src/ts/process/btwSideChat.svelte'

    interface Props {
        character: CharacterData
        chat: Chat
        /** Puts an answer into the chat's message box (the user still sends it). */
        onInsert?: (text: string) => void
    }

    let { character, chat, onInsert }: Props = $props()

    let input = $state('')
    let scroller: HTMLElement | undefined = $state()
    let inputEle: HTMLTextAreaElement | undefined = $state()
    let key = $derived(btwChatKey(character, chat))
    let view = $derived(getBtwChatState(key))
    let busy = $derived(view.pending !== null)

    const quickQuestions = $derived([
        { label: language.btwSideChat.quickRecap, prompt: language.btwSideChat.quickRecapPrompt },
        { label: language.btwSideChat.quickKnows, prompt: language.btwSideChat.quickKnowsPrompt },
        { label: language.btwSideChat.quickNextLine, prompt: language.btwSideChat.quickNextLinePrompt },
        { label: language.btwSideChat.quickCheck, prompt: language.btwSideChat.quickCheckPrompt },
    ])

    // Restore this tab's stored side history when the chat changes.
    $effect(() => {
        ensureBtwChat(key)
    })

    // Follow the newest exchange and the streaming answer.
    $effect(() => {
        void view.history.length
        void view.pending?.answer
        void view.error
        void tick().then(() => {
            if (scroller) scroller.scrollTop = scroller.scrollHeight
        })
    })

    // The on-screen keyboard would cover half the sheet on phones, so only
    // desktop focuses the box on open.
    $effect(() => {
        if (!isMobile) inputEle?.focus()
    })

    async function submit(text: string) {
        const question = text.trim()
        if (!question || busy) return
        input = ''
        const outcome = await askBtw(character, chat, question)
        // A stopped or failed question goes back to the box for another try.
        if ((outcome === 'aborted' || outcome === 'failed') && input === '') input = question
    }

    function onKeydown(e: KeyboardEvent) {
        if (e.key === 'Escape' && !e.isComposing) {
            closeBtwPanel()
            return
        }
        if (e.key !== 'Enter' || e.isComposing) return
        if (isSendKey(e, isMobile ? DBState.db.sendKeyMobile : DBState.db.sendKeyPC)) {
            e.preventDefault()
            void submit(input)
        }
    }
</script>

<aside
    class="absolute inset-x-0 bottom-0 top-[18%] z-[51] flex flex-col rounded-t-2xl border-t border-darkborderc bg-bgcolor text-textcolor shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:top-0 md:w-[400px] md:max-w-full md:rounded-none md:border-t-0 md:border-l"
    aria-label={language.btwSideChat.title}
    data-btw-side-chat
>
    <header class="flex shrink-0 items-start gap-2 border-b border-darkborderc px-3 py-2">
        <MessageCircleQuestionMarkIcon size={20} class="mt-0.5 shrink-0 text-textcolor2" />
        <div class="min-w-0 flex-1">
            <h2 class="text-sm font-semibold">{language.btwSideChat.title}</h2>
            <p class="text-xs text-textcolor2">{language.btwSideChat.subtitle}</p>
        </div>
        {#if view.history.length > 0 || busy}
            <button
                type="button"
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-textcolor2 transition-colors hover:bg-selected hover:text-red-400"
                aria-label={language.btwSideChat.clear}
                title={language.btwSideChat.clear}
                onclick={() => clearBtw(key)}
            ><Trash2Icon size={16} /></button>
        {/if}
        <button
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-textcolor2 transition-colors hover:bg-selected hover:text-textcolor"
            aria-label={language.btwSideChat.close}
            title={language.btwSideChat.close}
            onclick={closeBtwPanel}
        ><XIcon size={18} /></button>
    </header>

    <div bind:this={scroller} class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-y-contain px-3 py-3">
        {#if view.history.length === 0 && !busy}
            <p class="text-sm text-textcolor2">{language.btwSideChat.intro}</p>
            <div class="flex flex-wrap gap-2">
                {#each quickQuestions as quick}
                    <button
                        type="button"
                        class="rounded-full border border-darkborderc px-3 py-1.5 text-sm text-textcolor transition-colors hover:bg-selected"
                        onclick={() => submit(quick.prompt)}
                    >{quick.label}</button>
                {/each}
            </div>
        {/if}

        {#each view.history as exchange}
            <div class="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-selected px-3 py-2 text-sm">{exchange.question}</div>
            <div class="flex max-w-[92%] flex-col items-start gap-1 self-start">
                <div class="whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border border-darkborderc bg-darkbg px-3 py-2 text-sm">{exchange.answer}</div>
                {#if onInsert}
                    <button
                        type="button"
                        class="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-textcolor2 transition-colors hover:bg-selected hover:text-textcolor"
                        onclick={() => onInsert(exchange.answer)}
                    ><TextCursorInputIcon size={14} />{language.btwSideChat.insert}</button>
                {/if}
            </div>
        {/each}

        {#if view.pending}
            <div class="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-selected px-3 py-2 text-sm">{view.pending.question}</div>
            <div class="max-w-[92%] self-start whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border border-darkborderc bg-darkbg px-3 py-2 text-sm" aria-live="polite">
                {#if view.pending.answer}
                    {view.pending.answer}
                {:else}
                    <span class="italic text-textcolor2">{language.btwSideChat.thinking}</span>
                {/if}
            </div>
        {/if}

        {#if view.error}
            <div role="alert" class="whitespace-pre-wrap break-words rounded-lg border border-red-500/40 px-3 py-2 text-sm text-red-400">{language.btwSideChat.failed}: {view.error}</div>
        {/if}
    </div>

    <footer class="shrink-0 border-t border-darkborderc px-2 pb-2 pt-1">
        <p class="px-1 pb-1 text-xs text-textcolor2">{language.btwSideChat.contextNote(BTW_LIMITS.contextMessages)}</p>
        <div class="flex items-end gap-1 rounded-2xl border border-darkborderc px-2 py-1 transition-colors focus-within:border-textcolor">
            <textarea
                bind:this={inputEle}
                bind:value={input}
                rows="2"
                maxlength={BTW_LIMITS.questionChars}
                class="max-h-32 min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-base text-textcolor outline-hidden"
                placeholder={language.btwSideChat.placeholder}
                onkeydown={onKeydown}
            ></textarea>
            {#if busy}
                <button
                    type="button"
                    class="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-darkborderc text-textcolor transition-colors hover:bg-selected"
                    aria-label={language.btwSideChat.stop}
                    title={language.btwSideChat.stop}
                    onclick={() => stopBtw(key)}
                ><SquareIcon size={14} /></button>
            {:else}
                <button
                    type="button"
                    class="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-white transition-colors hover:bg-primary/80 disabled:opacity-40"
                    aria-label={language.btwSideChat.send}
                    title={language.btwSideChat.send}
                    disabled={!input.trim()}
                    onclick={() => submit(input)}
                ><SendIcon size={16} /></button>
            {/if}
        </div>
    </footer>
</aside>
