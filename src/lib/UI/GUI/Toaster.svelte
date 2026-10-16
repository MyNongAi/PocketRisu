<script lang="ts">
    import { Toaster as SonnerToaster, type ToasterProps } from 'svelte-sonner';
    import { isTouchDevice, MobileGUI } from 'src/ts/stores.svelte';
    import { splitChatOpen, splitChatWidth, splitRightInset } from 'src/ts/chatSplitPane';

    let { ...rest }: ToasterProps = $props();

    // With the PC split open, this window's toasts stay at the top right of
    // its own (left) workspace, clear of the right pane, which shows its own.
    const inset = $derived(splitRightInset($splitChatOpen, $splitChatWidth, $MobileGUI));
    const position = $derived<ToasterProps['position']>(inset > 0 || !$isTouchDevice ? 'top-right' : 'top-center');
    const offset = $derived<ToasterProps['offset']>(inset > 0 ? { top: '24px', right: `${inset + 24}px` } : undefined);
</script>

<SonnerToaster
    theme="dark"
    {position}
    {offset}
    richColors
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
    style="
        --normal-bg: var(--risu-theme-darkbg);
        --normal-text: var(--risu-theme-textcolor);
        --normal-border: var(--risu-theme-darkborderc);
        font-family: inherit;
    "
    {...rest}
/>

<style>
    :global(.risu-toast) {
        border-radius: 0.375rem;
        font-size: 0.875rem;
    }
    :global(.risu-toast-title) {
        font-weight: 500;
    }
</style>
