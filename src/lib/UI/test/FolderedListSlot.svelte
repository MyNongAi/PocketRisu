<script lang="ts">
    import type { Snippet } from 'svelte'
    let { children, child }: { children?: Snippet; child?: Snippet<[{ props: Record<string, never> }]> } = $props()
</script>
<div>{@render children?.()}{@render child?.({ props: {} })}</div>
