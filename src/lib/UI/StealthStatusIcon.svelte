<script lang="ts">
    // Read-only NAI stealth-metadata indicator for an asset row: green when the
    // image still carries the payload NovelAI's site can import, red when it
    // does not, the normal text colour otherwise.
    //
    // Detection waits until the row is near the viewport. The module asset
    // table renders a whole page at once, and every check fetches and decodes a
    // full image.
    import { ImageIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { getStealthStatus, requestStealthStatus } from 'src/ts/media/stealthStatusStore.svelte'

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
    const title = $derived(
        status === 'present' ? language.stealthPresent
            : status === 'absent' ? language.stealthAbsent
            : status === 'unsupported' ? language.stealthUnsupported
            : status === 'error' ? language.stealthUnknown
            : language.stealthChecking,
    )
</script>

<span
    bind:this={node}
    role="img"
    aria-label={title}
    {title}
    data-stealth={status ?? 'pending'}
    class="flex items-center justify-center"
    class:text-green-500={status === 'present'}
    class:text-red-500={status === 'absent'}
>
    <ImageIcon />
</span>
