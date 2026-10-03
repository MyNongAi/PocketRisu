<script lang="ts">
    // While the reload button has the laptop's server stopped, updated and
    // started again (laptopRestart.svelte.ts): the laptop's progress lines,
    // then its warnings if any. "Reload now" is always there, for a run that
    // hangs or a page that cannot see the laptop's progress.
    import { LoaderCircleIcon, TriangleAlertIcon } from '@lucide/svelte';
    import { language } from 'src/lang';
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte';
    import { dismissLaptopRestart, laptopRestart } from 'src/ts/laptopRestart.svelte';

    let now = $state(Date.now());
    $effect(() => {
        if (laptopRestart.phase !== 'running') return;
        const timer = setInterval(() => { now = Date.now(); }, 1000);
        return () => clearInterval(timer);
    });
    let elapsed = $derived(Math.max(0, Math.floor((now - laptopRestart.startedAt) / 1000)));
    let shownLines = $derived(laptopRestart.lines.slice(-10));
</script>

{#if laptopRestart.phase !== 'idle'}
    <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4" role="dialog" aria-modal="true" aria-label={language.laptopRestartTitle}>
        <div class="flex w-full max-w-md flex-col gap-3 rounded-lg border border-darkborderc bg-darkbg p-4 text-textcolor shadow-xl">
            <div class="flex items-center gap-2 font-bold">
                {#if laptopRestart.phase === 'running'}
                    <LoaderCircleIcon size={18} class="animate-spin" />
                    <span>{language.laptopRestartTitle}</span>
                    <span class="ml-auto text-xs font-normal text-textcolor2">{elapsed}s</span>
                {:else}
                    <TriangleAlertIcon size={18} class="text-yellow-500" />
                    <span>{laptopRestart.phase === 'warned' ? language.laptopRestartWarned : language.laptopRestartFailed}</span>
                {/if}
            </div>
            {#if laptopRestart.phase === 'warned'}
                <div class="flex flex-col gap-1 text-xs text-yellow-500">
                    {#each laptopRestart.warnings as line, i (i)}
                        <span class="break-words">{line}</span>
                    {/each}
                </div>
            {:else if shownLines.length > 0}
                <div class="flex flex-col gap-0.5 rounded-md bg-bgcolor p-2 font-mono text-xs text-textcolor2">
                    {#each shownLines as line, i (i)}
                        <span class="break-words">{line}</span>
                    {/each}
                </div>
            {:else if laptopRestart.phase === 'running'}
                <span class="text-xs text-textcolor2">{language.laptopRestartHint}</span>
            {/if}
            <div class="flex justify-end gap-2">
                {#if laptopRestart.phase !== 'running'}
                    <ShButton variant="ghost" size="sm" onclick={dismissLaptopRestart}>{language.close}</ShButton>
                {/if}
                <ShButton variant={laptopRestart.phase === 'running' ? 'ghost' : 'default'} size="sm" onclick={() => location.reload()}>{language.laptopRestartReloadNow}</ShButton>
            </div>
        </div>
    </div>
{/if}
