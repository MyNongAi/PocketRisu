<script lang="ts">
    import type { Snippet } from "svelte";

    let {
        title,
        titleActions,
        children,
        contentClassName = '',
    }: {
        title: string;
        titleActions?: Snippet;
        children?: Snippet;
        contentClassName?: string;
    } = $props();
</script>

<div class="mb-4 mt-2 flex min-w-0 items-center gap-2">
    <h2 class="min-w-0 grow truncate text-2xl font-bold">{title}</h2>
    {#if titleActions}
        <div class="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {@render titleActions()}
        </div>
    {/if}
</div>
<div class={`flex min-h-0 flex-col ${contentClassName}`}>
    {@render children?.()}
</div>
