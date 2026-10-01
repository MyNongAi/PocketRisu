<script lang="ts">
    import { XIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { importTasks } from 'src/ts/importProgress'

    // onMinimize: the X; the task keeps running and the card collapses into
    // the toaster's small button (ImportProgressToaster).
    let { id, onMinimize }: { id: string, onMinimize?: () => void } = $props()
    const entry = $derived($importTasks.get(id))
</script>

{#if entry}
    <div class="import-card" class:done={entry.phase === 'done'} class:failed={entry.phase === 'failed'}>
        <div class="row">
            <span class="name" title={entry.fileName}>{entry.fileName}</span>
            <span class="label">{entry.label}</span>
            {#if entry.progress !== null}
                <span class="percent">{Math.round(entry.progress)}%</span>
            {/if}
            {#if onMinimize && (entry.phase === 'queued' || entry.phase === 'running')}
                <button type="button" class="minimize" title={language.importProgressMinimize} aria-label={language.importProgressMinimize} onclick={onMinimize}>
                    <XIcon size={14} />
                </button>
            {/if}
        </div>
        <div class="track" aria-label={`${entry.fileName} ${entry.label}`}>
            {#if entry.progress === null && entry.phase === 'running'}
                <div class="bar indeterminate"></div>
            {:else}
                <div class="bar" style={`width:${entry.progress ?? 0}%`}></div>
            {/if}
        </div>
        {#if entry.error}
            <div class="error" title={entry.error}>{entry.error}</div>
        {/if}
    </div>
{/if}

<style>
    .import-card {
        width: 100%; min-width: 260px; padding: 10px 12px;
        color: var(--risu-theme-textcolor); background: var(--risu-theme-darkbg);
        border: 1px solid var(--risu-theme-darkborderc); border-left: 4px solid var(--risu-theme-primary);
        border-radius: .5rem; font-size: .8125rem;
    }
    .import-card.done { border-left-color: var(--risu-theme-success); }
    .import-card.failed { border-left-color: var(--risu-theme-draculared); }
    .row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .label { color: var(--risu-theme-textcolor2); white-space: nowrap; }
    .percent { width: 36px; text-align: right; color: var(--risu-theme-textcolor2); font-variant-numeric: tabular-nums; }
    .minimize { display: flex; flex-shrink: 0; padding: 2px; border-radius: 4px; color: var(--risu-theme-textcolor2); }
    .minimize:hover { color: var(--risu-theme-textcolor); background: var(--risu-theme-selected); }
    .track { position: relative; height: 4px; margin-top: 8px; overflow: hidden; border-radius: 999px; background: var(--risu-theme-selected); }
    .bar { height: 100%; border-radius: inherit; background: var(--risu-theme-primary); transition: width .18s ease; }
    .done .bar { background: var(--risu-theme-success); }
    .failed .bar { background: var(--risu-theme-draculared); }
    .indeterminate { position: absolute; width: 42%; animation: import-slide 1.05s ease-in-out infinite; }
    .error { margin-top: 6px; overflow: hidden; color: var(--risu-theme-draculared); text-overflow: ellipsis; white-space: nowrap; font-size: .75rem; }
    @keyframes import-slide { from { left: -45%; } to { left: 105%; } }
</style>
