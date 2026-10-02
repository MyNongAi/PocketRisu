<script lang="ts">
    // Chain before a module's title (src/ts/gui/pairedModules.ts): green while
    // bots have it as their own module, red once the bots it was paired with
    // are gone. The tooltip names them.
    import { Link2Icon } from '@lucide/svelte';
    import type { ModuleLink } from 'src/ts/gui/pairedModules';

    let { link }: { link: ModuleLink | undefined } = $props();
    let label = $derived(link
        ? link.state === 'linked'
            ? `전용 모듈 · 연결됨: ${link.names.join(', ')}`
            : `전용 모듈 · 연결 끊김 (짝 봇이 없음): ${link.names.join(', ')}`
        : '')
</script>

{#if link}
    <span
        class="mr-0.5 inline-flex align-[-0.15em] {link.state === 'linked' ? 'text-emerald-500' : 'text-red-500'}"
        role="img"
        aria-label={label}
        title={label}
    ><Link2Icon size={14} strokeWidth={2.5} /></span>
{/if}
