<script lang="ts">
    // The dashed frame a FileDropSurface shows while outside files are dragged
    // over it (src/ts/gui/fileDropSurface.svelte.ts). Sticky, so it stays in
    // view in a scrolled panel.
    import type { Component } from 'svelte';

    interface Props {
        active: boolean;
        label: string;
        icon: Component<{ size?: number }>;
    }

    let { active, label, icon: Icon }: Props = $props();
</script>

<div
    class={`pointer-events-none sticky top-0 z-30 flex shrink-0 items-center justify-center gap-2 overflow-hidden rounded-md border-2 border-dashed transition-all
        ${active ? 'mb-3 h-16 border-primary bg-primary/15 px-3 text-primary opacity-100 shadow-lg' : 'h-0 border-transparent opacity-0'}`}
    data-file-drop-indicator
    role="status"
    aria-hidden={!active}
>
    <Icon size={20} />
    <span class="text-sm font-bold">{label}</span>
</div>
