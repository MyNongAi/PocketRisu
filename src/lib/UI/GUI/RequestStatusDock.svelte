<script lang="ts">
    // Round buttons for the request-status toasts folded with "−"
    // (src/ts/status/requestStatusDock.ts). Spinning while the reply is being
    // written: a tap opens the toast again. A check once it is done: a tap
    // opens the chat it was written in. A failure shows briefly and leaves
    // with its toast (RequestStatusToaster clears it).
    import { toast } from 'svelte-sonner'
    import { requestStatuses, clearStatus } from 'src/ts/status/requestStatus'
    import { dockState, minimizedRequests, unminimizeRequest } from 'src/ts/status/requestStatusDock'
    import { DBState, MobileGUI, selIdState } from 'src/ts/stores.svelte'
    import { splitChatOpen, splitChatWidth, splitRightInset } from 'src/ts/chatSplitPane'
    import { changeChar } from 'src/ts/characters'
    import { changeChatTo } from 'src/ts/globalApi.svelte'
    import { language } from 'src/lang'
    import RequestStatusToast from './RequestStatusToast.svelte'

    // Inside the left workspace while split (the right pane has its own dock).
    const inset = $derived(splitRightInset($splitChatOpen, $splitChatWidth, $MobileGUI))

    const items = $derived($minimizedRequests
        .map((id) => ({ id, entry: $requestStatuses.get(id) }))
        .filter((item): item is { id: string, entry: NonNullable<typeof item.entry> } => !!item.entry))

    const currentChatId = $derived.by(() => {
        const character = DBState.db.characters?.[selIdState.selId]
        return character?.chats?.[character.chatPage]?.id ?? null
    })

    // Reaching the chat another way also answers its check.
    $effect(() => {
        const here = currentChatId
        for (const { id, entry } of items) {
            if (here && entry.chatId === here && dockState(entry) === 'done') close(id)
        }
    })

    function close(id: string): void {
        unminimizeRequest(id)
        clearStatus(id)
    }

    function expand(id: string): void {
        unminimizeRequest(id)
        toast.custom(RequestStatusToast, {
            id: `req:${id}`,
            duration: Number.POSITIVE_INFINITY,
            componentProps: { id },
        })
    }

    function openChat(id: string, chatId: string | undefined): void {
        close(id)
        if (!chatId) return
        const characters = DBState.db.characters ?? []
        const characterIndex = characters.findIndex((character) => character?.chats?.some((chat) => chat?.id === chatId))
        if (characterIndex < 0) return
        if (characterIndex === selIdState.selId) {
            changeChatTo(chatId)
            return
        }
        // Open the character on that chat directly.
        const character = characters[characterIndex]
        const chatIndex = character.chats.findIndex((chat) => chat?.id === chatId)
        if (chatIndex >= 0) character.chatPage = chatIndex
        changeChar(characterIndex)
    }

    // Read when drawn: the dock mounts before the saved language is applied.
    const rs = () => language.requestStatus
</script>

{#if items.length > 0}
    <div class="request-dock" style:right={`calc(0.5rem + ${inset}px)`} role="group" aria-label={rs()?.dockLabel ?? 'Folded requests'}>
        {#each items as { id, entry } (id)}
            {@const state = dockState(entry)}
            {#if state === 'running'}
                <button type="button" class="request-dock-button" title={rs()?.dockExpand ?? 'Show the request'} aria-label={rs()?.dockExpand ?? 'Show the request'} onclick={() => expand(id)}>
                    <span class="request-dock-spinner" aria-hidden="true"></span>
                </button>
            {:else if state === 'done'}
                <button type="button" class="request-dock-button request-dock-done" title={rs()?.dockOpenChat ?? 'Open the chat'} aria-label={rs()?.dockOpenChat ?? 'Open the chat'} onclick={() => openChat(id, entry.chatId)}>
                    <span aria-hidden="true">✅</span>
                </button>
            {:else}
                <button type="button" class="request-dock-button request-dock-failed" title={rs()?.failed ?? 'Failed'} aria-label={rs()?.failed ?? 'Failed'} onclick={() => expand(id)}>
                    <span aria-hidden="true">❗</span>
                </button>
            {/if}
        {/each}
    </div>
{/if}

<style>
    .request-dock {
        position: fixed;
        top: calc(env(safe-area-inset-top, 0px) + 3.5rem);
        right: 0.5rem;
        z-index: 60;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }
    .request-dock-button {
        display: grid;
        place-items: center;
        width: 2.5rem;
        height: 2.5rem;
        border-radius: 999px;
        background: var(--risu-theme-darkbg);
        border: 1px solid var(--risu-theme-darkborderc);
        box-shadow: 0 4px 12px rgb(0 0 0 / 0.35);
        font-size: 1.1rem;
        line-height: 1;
        transition: border-color .15s ease, transform .15s ease;
    }
    .request-dock-button:hover { border-color: var(--risu-theme-primary); }
    .request-dock-button:active { transform: scale(0.94); }
    .request-dock-button:focus-visible { outline: 2px solid var(--risu-theme-primary); outline-offset: 2px; }
    .request-dock-done { border-color: var(--risu-theme-success); }
    .request-dock-failed { border-color: var(--risu-theme-draculared); }
    .request-dock-spinner {
        width: 1.25rem;
        height: 1.25rem;
        border-radius: 999px;
        border: 2.5px solid var(--risu-theme-selected);
        border-top-color: var(--risu-theme-primary);
        animation: request-dock-spin 0.9s linear infinite;
    }
    @keyframes request-dock-spin { to { transform: rotate(360deg); } }
</style>
