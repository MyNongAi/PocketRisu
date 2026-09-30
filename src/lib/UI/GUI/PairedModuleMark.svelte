<script lang="ts">
    // Red link before a module's title when bots have it as their own module
    // (src/ts/gui/pairedModules.ts). The tooltip names them.
    import { Link2Icon } from '@lucide/svelte';

    let { names }: { names: readonly string[] | undefined } = $props();
</script>

{#if names?.length}
    <span
        class="mr-0.5 inline-flex align-[-0.15em] text-red-500"
        role="img"
        aria-label={`전용 모듈: ${names.join(', ')}`}
        title={`전용 모듈: ${names.join(', ')}`}
    ><Link2Icon size={14} strokeWidth={2.5} /></span>
{/if}
