<script lang="ts">
    // Read-only NAI stealth-metadata indicator for an asset row: green when the
    // image still carries the payload NovelAI's site can import, yellow when
    // only its PNG text or EXIF holds the prompt, red when nothing does, the
    // normal text colour otherwise.
    //
    // Detection waits until the row is near the viewport. The module asset
    // table renders a whole page at once, and every check fetches and decodes a
    // full image.
    import { ImageIcon } from '@lucide/svelte'
    import { getStealthStatus, hasTextMetadataOnly, requestStealthStatus, stealthStatusTitle } from 'src/ts/media/stealthStatusStore.svelte'

    let { path, extension }: { path: string; extension: string } = $props()

    let node: HTMLSpanElement | undefined = $state()
    let visible = $state(false)

    $effect(() => {
        if (!node || visible) return
        if (typeof IntersectionObserver === 'undefined') {
            visible = true
            return
        }
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                visible = true
                observer.disconnect()
            }
        }, { rootMargin: '200px' })
        observer.observe(node)
        return () => observer.disconnect()
    })

    $effect(() => {
        if (visible && path) requestStealthStatus(path, extension)
    })

    const status = $derived(getStealthStatus(path))
    const title = $derived(stealthStatusTitle(status))
</script>

<span
    bind:this={node}
    role="img"
    aria-label={title}
    {title}
    data-stealth={status ?? 'pending'}
    class="flex items-center justify-center"
    class:text-green-500={status === 'present'}
    class:text-yellow-500={hasTextMetadataOnly(status)}
    class:text-red-500={status === 'absent'}
>
    <ImageIcon />
</span>
