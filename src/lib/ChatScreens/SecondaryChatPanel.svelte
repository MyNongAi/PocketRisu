<script lang="ts">
    import { XIcon } from '@lucide/svelte'
    import { getSecondaryRisuPaneUrl, splitChatOpen } from 'src/ts/chatSplitPane'

    const paneUrl = getSecondaryRisuPaneUrl()
</script>

<aside class="relative h-full min-h-0 min-w-0 border-l border-darkborderc bg-bgcolor" aria-label="Secondary Risu workspace">
    <button
        type="button"
        class="absolute right-2 top-2 z-50 flex h-8 w-8 items-center justify-center rounded-md border border-darkborderc bg-darkbg/90 text-textcolor2 shadow hover:text-red-400"
        aria-label="우측 채팅 닫기"
        title="우측 채팅 닫기 (채팅 데이터는 삭제하지 않음)"
        onclick={() => splitChatOpen.set(false)}
    ><XIcon size={18}/></button>
    <iframe
        class="block h-full w-full border-0 bg-bgcolor"
        src={paneUrl}
        title="Secondary PocketRisu workspace"
        allow="autoplay; clipboard-read; clipboard-write"
    ></iframe>
</aside>
