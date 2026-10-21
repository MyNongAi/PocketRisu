<script lang="ts">
    import { Toaster as SonnerToaster, type ToasterProps } from 'svelte-sonner';
    import { isTouchDevice } from 'src/ts/stores.svelte';
    import { dockVisible } from 'src/ts/importDock';

    // `id`, `position` and `offset` given here win: a split pane's own
    // toaster (PaneToasters.svelte) sits over its pane. The app's toaster
    // keeps the window's top right, the split or not. `width`: cards
    // narrower than sonner's 356px, for a narrow pane.
    let { width, ...rest }: ToasterProps & { width?: number } = $props();

    const position = $derived<ToasterProps['position']>(!$isTouchDevice ? 'top-right' : 'top-center');
    // Left of the dock column of folded requests and downloads while it shows
    // (RequestStatusDock: 2.5rem buttons 0.5rem from the edge).
    const dockRoom = $derived($dockVisible && position === 'top-right' ? 48 : 0);
    const offset = $derived<ToasterProps['offset']>(dockRoom > 0 ? { top: '24px', right: `${24 + dockRoom}px` } : undefined);
</script>

<SonnerToaster
    theme="dark"
    {position}
    {offset}
    richColors
    expand
    swipeDirections={['top', 'left', 'right']}
    duration={3500}
    visibleToasts={8}
    toastOptions={{
        classes: {
            toast: 'risu-toast',
            title: 'risu-toast-title',
            description: 'risu-toast-description',
        },
    }}
    class={width ? 'risu-toaster-narrow' : undefined}
    style="
        --normal-bg: var(--risu-theme-darkbg);
        --normal-text: var(--risu-theme-textcolor);
        --normal-border: var(--risu-theme-darkborderc);
        {width ? `--risu-toast-width: ${width}px;` : ''}
        font-family: inherit;
    "
    {...rest}
/>

<style>
    /* sonner sets --width inline; only an important rule narrows it. */
    :global(ol.risu-toaster-narrow) {
        --width: var(--risu-toast-width) !important;
    }
    :global(.risu-toast) {
        border-radius: 0.375rem;
        font-size: 0.875rem;
    }
    :global(.risu-toast-title) {
        font-weight: 500;
    }
</style>
