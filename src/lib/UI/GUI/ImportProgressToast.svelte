<script lang="ts">
    import { onDestroy } from 'svelte'
    import { MinusIcon, XIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { cancelImportTask, dropQueuedImportTask, importTasks } from 'src/ts/importProgress'

    // The header's two buttons (the user's choice, 2026-10-05): "-" folds the
    // card into the toaster's small button and the task keeps running
    // (onMinimize, ImportProgressToaster); "x" stops the download.
    let { id, onMinimize, onClose }: { id: string, onMinimize?: () => void, onClose?: () => void } = $props()
    const entry = $derived($importTasks.get(id))

    // Cancelling throws away minutes of work, so the x takes a second tap
    // within a few seconds (like the asset delete buttons).
    let armed = $state(false)
    let disarmTimer: ReturnType<typeof setTimeout> | undefined
    // "×" under "−" (the user's request, 2026-10-18): a queued task leaves
    // the queue, a running one that can roll back stops (second tap), and
    // otherwise the card just closes while the task goes on.
    function pressClose(): void {
        if (!entry) return
        if (entry.phase === 'queued') { dropQueuedImportTask(id); return }
        if (entry.cancel && entry.phase === 'running') { pressCancel(); return }
        onClose?.()
    }

    function pressCancel(): void {
        if (!armed) {
            armed = true
            clearTimeout(disarmTimer)
            disarmTimer = setTimeout(() => { armed = false }, 3000)
            return
        }
        clearTimeout(disarmTimer)
        armed = false
        cancelImportTask(id)
    }
    onDestroy(() => clearTimeout(disarmTimer))
</script>

{#if entry}
    {@const closeLabel = entry.phase === 'queued' ? language.importProgress.drop
        : entry.cancel && entry.phase === 'running' ? (armed ? language.importProgress.cancelConfirm : language.importProgress.cancel)
        : language.importProgress.close}
    <div class="import-card" class:done={entry.phase === 'done'} class:failed={entry.phase === 'failed'} class:cancelled={entry.phase === 'cancelled'}>
        <div class="main">
        <div class="row">
            <span class="name" title={entry.fileName}>{entry.fileName}</span>
            <span class="label" class:armed-text={armed}>{armed ? language.importProgress.cancelConfirm : entry.label}</span>
            {#if entry.progress !== null}
                <span class="percent">{Math.round(entry.progress)}%</span>
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
        {#if entry.detail}
            <div class="detail">{entry.detail}</div>
        {/if}
        </div>
        <div class="side">
            {#if onMinimize && (entry.phase === 'queued' || entry.phase === 'running')}
                <button type="button" class="icon minimize" title={language.importProgressMinimize} aria-label={language.importProgressMinimize} onclick={onMinimize}>
                    <MinusIcon size={14} />
                </button>
            {/if}
            <button type="button" class="icon cancel" class:armed title={closeLabel} aria-label={closeLabel} onclick={pressClose}>
                <XIcon size={14} />
            </button>
        </div>
    </div>
{/if}

<style>
    .import-card {
        display: flex; gap: 6px;
        width: 100%; min-width: 260px; padding: 10px 8px 10px 12px;
        color: var(--risu-theme-textcolor); background: var(--risu-theme-darkbg);
        border: 1px solid var(--risu-theme-darkborderc); border-left: 4px solid var(--risu-theme-primary);
        border-radius: .5rem; font-size: .8125rem;
    }
    .import-card.done { border-left-color: var(--risu-theme-success); }
    .import-card.failed { border-left-color: var(--risu-theme-draculared); }
    .import-card.cancelled { border-left-color: var(--risu-theme-textcolor2); }
    .main { flex: 1; min-width: 0; }
    .side { display: flex; flex-direction: column; gap: 2px; flex-shrink: 0; }
    .row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .label { color: var(--risu-theme-textcolor2); white-space: nowrap; }
    .percent { width: 36px; text-align: right; color: var(--risu-theme-textcolor2); font-variant-numeric: tabular-nums; }
    .icon { display: flex; flex-shrink: 0; align-items: center; gap: 4px; padding: 2px; border-radius: 4px; color: var(--risu-theme-textcolor2); }
    .icon:hover { color: var(--risu-theme-textcolor); background: var(--risu-theme-selected); }
    .cancel.armed { color: var(--risu-theme-draculared); }
    .armed-text { color: var(--risu-theme-draculared); white-space: nowrap; }
    .track { position: relative; height: 4px; margin-top: 8px; overflow: hidden; border-radius: 999px; background: var(--risu-theme-selected); }
    .bar { height: 100%; border-radius: inherit; background: var(--risu-theme-primary); transition: width .18s ease; }
    .done .bar { background: var(--risu-theme-success); }
    .failed .bar { background: var(--risu-theme-draculared); }
    .cancelled .bar { background: var(--risu-theme-textcolor2); }
    .indeterminate { position: absolute; width: 42%; animation: import-slide 1.05s ease-in-out infinite; }
    .error { margin-top: 6px; overflow: hidden; color: var(--risu-theme-draculared); text-overflow: ellipsis; white-space: nowrap; font-size: .75rem; }
    .detail { margin-top: 6px; color: var(--risu-theme-textcolor2); font-size: .75rem; line-height: 1.35; overflow-wrap: anywhere; }
    @keyframes import-slide { from { left: -45%; } to { left: 105%; } }
</style>
