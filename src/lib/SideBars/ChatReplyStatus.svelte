<script lang="ts">
    // A chat row's reply status: the composer's spinner (green) while a reply
    // for this chat runs, foreground, on the server or on another device, then
    // a check until the chat is opened again. The chat on screen shows its check only briefly.
    import { chatGenKey, generationStates } from 'src/ts/process/generationState'
    import { clearFinishedReply, finishedReplies } from 'src/ts/gui/chatReplyStatus'
    import { remoteGenerations } from 'src/ts/sync/remoteActivity'

    interface Props {
        chatId: string | undefined
        current: boolean
        /** A reroll's new reply waits on a later page here (the arrow's dot, chatSwipes.ts). */
        unseen?: boolean
    }
    let { chatId, current, unseen = false }: Props = $props()

    const running = $derived(!!chatId && ($generationStates.has(chatGenKey(chatId)) || $remoteGenerations.has(chatId)))
    const done = $derived(!running && !!chatId && $finishedReplies.has(chatId))

    // Opening the chat clears its check.
    // svelte-ignore state_referenced_locally
    let wasCurrent = current
    $effect(() => {
        if (current && !wasCurrent) clearFinishedReply(chatId)
        wasCurrent = current
    })

    // The chat on screen saw its reply arrive: its check goes after a moment,
    // or once the app is back in front (the user's report, 2026-10-21: it
    // stayed until the chat was left and opened again). A reroll whose new
    // reply waits on a later page keeps it until that page is turned to, and
    // then it goes at once (the user's request, the same day).
    const SEEN_AFTER_MS = 2000
    let waitedForPage = false
    $effect(() => {
        if (!current || !done) return
        if (unseen) {
            waitedForPage = true
            return
        }
        if (waitedForPage) {
            waitedForPage = false
            clearFinishedReply(chatId)
            return
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const settle = () => {
            clearTimeout(timer)
            if (document.visibilityState === 'visible') timer = setTimeout(() => clearFinishedReply(chatId), SEEN_AFTER_MS)
        }
        settle()
        document.addEventListener('visibilitychange', settle)
        return () => {
            clearTimeout(timer)
            document.removeEventListener('visibilitychange', settle)
        }
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
