<script lang="ts">
    // A chat row's reply status: the composer's spinner (green) while a reply
    // for this chat runs, foreground or on the server, then a check until the
    // chat is opened again.
    import { chatGenKey, generationStates } from 'src/ts/process/generationState'
    import { clearFinishedReply, finishedReplies } from 'src/ts/gui/chatReplyStatus'

    interface Props {
        chatId: string | undefined
        current: boolean
    }
    let { chatId, current }: Props = $props()

    const running = $derived(!!chatId && $generationStates.has(chatGenKey(chatId)))
    const done = $derived(!running && !!chatId && $finishedReplies.has(chatId))

    // Opening the chat clears its check. A chat that was already open when
    // its reply finished keeps the check until it is left and opened again.
    // svelte-ignore state_referenced_locally
    let wasCurrent = current
    $effect(() => {
        if (current && !wasCurrent) clearFinishedReply(chatId)
        wasCurrent = current
    })
</script>

{#if running}
    <span class="reply-spinner mr-1.5 shrink-0" role="status" title="응답 생성 중" aria-label="응답 생성 중"></span>
{:else if done}
    <span class="mr-1 shrink-0 text-sm leading-none" role="status" title="응답 도착" aria-label="응답 도착">✅</span>
{/if}

<style>
    .reply-spinner {
        display: inline-block;
        width: 0.9rem;
        height: 0.9rem;
        border-radius: 50%;
        border: 0.2rem solid rgba(0, 0, 0, 0);
        border-top-color: #34d399;
        border-left-color: #34d399;
        animation: reply-spin 1s linear infinite;
    }
    @keyframes reply-spin {
        to { transform: rotate(360deg); }
    }
</style>
