<script lang="ts">
    // Closed with the rail's split button (Sidebar.svelte), which turns into
    // a close button while the split is open.
    import { getSecondaryRisuPaneUrl, listenForSplitClose } from 'src/ts/chatSplitPane'

    const paneUrl = getSecondaryRisuPaneUrl()
    let frame: HTMLIFrameElement | undefined = $state()
    // The pane's own split button (its menu) closes the split from inside.
    $effect(() => listenForSplitClose(() => frame?.contentWindow))
</script>

<aside class="relative h-full min-h-0 min-w-0 border-l border-darkborderc bg-bgcolor" aria-label="Secondary Risu workspace">
    <iframe
        bind:this={frame}
        class="block h-full w-full border-0 bg-bgcolor"
        src={paneUrl}
        title="Secondary PocketRisu workspace"
        allow="autoplay; clipboard-read; clipboard-write"
    ></iframe>
</aside>
