<script lang="ts">
    import type { Snippet } from "svelte";

    let {
        title,
        children,
        contentClassName = '',
    }: {
        title: string;
        children?: Snippet;
        contentClassName?: string;
    } = $props();
</script>

<h2 class="mb-4 text-2xl font-bold mt-2">{title}</h2>
<div class={`flex min-h-0 flex-col ${contentClassName}`}>
    {@render children?.()}
</div>
