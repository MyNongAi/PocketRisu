<script lang="ts">
    import { getSecondaryRisuPaneUrl } from 'src/ts/chatSplitPane'

    const paneUrl = getSecondaryRisuPaneUrl()
</script>

<aside class="h-full min-h-0 min-w-0 border-l border-darkborderc bg-bgcolor" aria-label="Secondary Risu workspace">
    <iframe
        class="block h-full w-full border-0 bg-bgcolor"
        src={paneUrl}
        title="Secondary PocketRisu workspace"
        allow="autoplay; clipboard-read; clipboard-write"
    ></iframe>
</aside>
