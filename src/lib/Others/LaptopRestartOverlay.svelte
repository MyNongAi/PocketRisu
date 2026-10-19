<script lang="ts">
    // The reload button's run on the laptop (laptopRestart.svelte.ts), shown
    // as a bar at the top that leaves the screen usable and folds to one line
    // (the user's request, 2026-10-20: it was a modal in the middle that
    // locked everything, while the server now mostly keeps running). Folded,
    // it shows the newest progress line; unfolded, the last ten. "Reload now"
    // is always there, for a run that hangs or a page that cannot see it.
    import { ChevronDownIcon, ChevronUpIcon, LoaderCircleIcon, TriangleAlertIcon, CheckIcon, XIcon, RotateCwIcon } from '@lucide/svelte';
    import { language } from 'src/lang';
    import { dismissLaptopRestart, laptopRestart } from 'src/ts/laptopRestart.svelte';

    const FOLD_KEY = 'pocketrisu-laptop-restart-folded'
    let folded = $state(true)
    try { folded = localStorage.getItem(FOLD_KEY) !== '0' } catch {}
    function toggleFold() {
        folded = !folded
        try { localStorage.setItem(FOLD_KEY, folded ? '1' : '0') } catch {}
    }

    let now = $state(Date.now());
    $effect(() => {
        if (laptopRestart.phase !== 'running') return;
        const timer = setInterval(() => { now = Date.now(); }, 1000);
        return () => clearInterval(timer);
    });
    let elapsed = $derived(Math.max(0, Math.floor((now - laptopRestart.startedAt) / 1000)));
    let shownLines = $derived(laptopRestart.lines.slice(-10));
    let lastLine = $derived((laptopRestart.lines.at(-1) ?? '').replace(/^\d{2}:\d{2}:\d{2} /, ''));

    // Nothing to reload: the bar goes away by itself.
    $effect(() => {
        if (laptopRestart.phase !== 'done') return;
        const timer = setTimeout(dismissLaptopRestart, 4000);
        return () => clearTimeout(timer);
    });
</script>

{#if laptopRestart.phase !== 'idle'}
    <div class="pointer-events-none fixed inset-x-0 top-2 z-[60] flex justify-center px-2">
        <div class="pointer-events-auto flex w-full max-w-md flex-col rounded-lg border border-darkborderc bg-darkbg/95 text-textcolor shadow-lg backdrop-blur" role="status" aria-label={language.laptopRestartTitle}>
            <div class="flex min-h-10 items-center gap-2 px-3 py-1.5 text-sm">
                {#if laptopRestart.phase === 'running'}
                    <LoaderCircleIcon size={16} class="shrink-0 animate-spin" />
                {:else if laptopRestart.phase === 'done'}
                    <CheckIcon size={16} class="shrink-0 text-emerald-400" />
                {:else}
                    <TriangleAlertIcon size={16} class="shrink-0 text-yellow-500" />
                {/if}
                <span class="min-w-0 grow truncate">
                    {#if laptopRestart.phase === 'running'}
                        {folded && lastLine ? lastLine : language.laptopRestartTitle}
                    {:else if laptopRestart.phase === 'done'}
                        {language.laptopRestartDone}
                    {:else}
                        {laptopRestart.phase === 'warned' ? language.laptopRestartWarned : language.laptopRestartFailed}
                    {/if}
                </span>
                {#if laptopRestart.phase === 'running'}
                    <span class="shrink-0 text-xs text-textcolor2 tabular-nums">{elapsed}s</span>
                {/if}
                <button class="shrink-0 p-1 text-textcolor2 hover:text-textcolor" title={folded ? language.laptopRestartUnfold : language.laptopRestartFold} aria-label={folded ? language.laptopRestartUnfold : language.laptopRestartFold} onclick={toggleFold}>
                    {#if folded}<ChevronDownIcon size={16} />{:else}<ChevronUpIcon size={16} />{/if}
                </button>
                <button class="shrink-0 p-1 text-textcolor2 hover:text-textcolor" title={language.laptopRestartReloadNow} aria-label={language.laptopRestartReloadNow} onclick={() => location.reload()}>
                    <RotateCwIcon size={16} />
                </button>
                {#if laptopRestart.phase !== 'running'}
                    <button class="shrink-0 p-1 text-textcolor2 hover:text-textcolor" title={language.close} aria-label={language.close} onclick={dismissLaptopRestart}>
                        <XIcon size={16} />
                    </button>
                {/if}
            </div>
            {#if laptopRestart.phase === 'warned'}
                <div class="flex flex-col gap-1 border-t border-darkborderc px-3 py-2 text-xs text-yellow-500">
                    {#each laptopRestart.warnings as line, i (i)}
                        <span class="break-words">{line}</span>
                    {/each}
                </div>
            {:else if !folded}
                <div class="flex flex-col gap-0.5 border-t border-darkborderc px-3 py-2 font-mono text-xs text-textcolor2">
                    {#if shownLines.length > 0}
                        {#each shownLines as line, i (i)}
                            <span class="break-words">{line}</span>
                        {/each}
                    {:else}
                        <span>{language.laptopRestartHint}</span>
                    {/if}
                </div>
            {/if}
        </div>
    </div>
{/if}
