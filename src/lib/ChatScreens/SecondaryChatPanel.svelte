<script lang="ts">
    // The split's right pane: a chat screen of this app (chatPanes.svelte.ts),
    // not the whole app again in an iframe, which held the database twice in
    // one tab until it crashed (the user's report, 2026-10-20). A chat dragged
    // from the chat list onto it opens here; touched, it becomes the selected
    // chat, so the sidebar then opens bots and chats in it. Closed with the
    // rail's split button (Sidebar.svelte).
    import ChatScreen from './ChatScreen.svelte'
    import { RISU_CHAT_ROOM_DRAG_TYPE } from 'src/ts/dragTypes'
    import { parseChatRoomDragPayload } from 'src/ts/chatSplitPane'
    import { showInSidePane } from 'src/ts/paneActivation'

    let dragOver = $state(false)
    const carriesChat = (event: DragEvent) => !!event.dataTransfer?.types.includes(RISU_CHAT_ROOM_DRAG_TYPE)

    function over(event: DragEvent) {
        if (!carriesChat(event)) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
        dragOver = true
    }

    function leave(event: DragEvent) {
        if ((event.currentTarget as Node).contains(event.relatedTarget as Node | null)) return
        dragOver = false
    }

    function drop(event: DragEvent) {
        if (!carriesChat(event)) return
        event.preventDefault()
        event.stopPropagation()
        dragOver = false
        const payload = parseChatRoomDragPayload(event.dataTransfer?.getData(RISU_CHAT_ROOM_DRAG_TYPE) ?? '')
        if (payload) showInSidePane({ chaId: payload.characterId, chatId: payload.chatId })
    }
</script>

<aside
    class="side-chat-pane relative flex grow h-full min-h-0 min-w-0 border-l border-darkborderc bg-bgcolor"
    aria-label="Secondary chat"
    ondragentercapture={over}
    ondragovercapture={over}
    ondragleave={leave}
    ondropcapture={drop}
>
    <ChatScreen pane="side" />
    {#if dragOver}
        <div class="pointer-events-none absolute inset-0 z-50 border-2 border-dashed border-primary bg-primary/10"></div>
    {/if}
</aside>

<style>
    .side-chat-pane {
        /* Bot CSS with position:fixed stays inside the pane, as it did in the iframe. */
        contain: paint;
        isolation: isolate;
        overflow: clip;
    }
</style>
