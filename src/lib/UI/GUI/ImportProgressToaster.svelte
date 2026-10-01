<script lang="ts">
    import { onDestroy } from 'svelte'
    import { get } from 'svelte/store'
    import { toast } from 'svelte-sonner'
    import { DownloadIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { clearImportTask, importTasks } from 'src/ts/importProgress'
    import ImportProgressToast from './ImportProgressToast.svelte'

    const shown = new Set<string>()
    const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>()
    // Tasks whose card the user closed (its X, or a swipe) while they still
    // run: they collapse into the small button below, which brings them back.
    const minimized = new Set<string>()
    // Our own dismissals, so they are not taken for the user's.
    const dismissing = new Set<string>()
    let pill = $state<{ count: number, progress: number | null, failed: boolean }>({ count: 0, progress: null, failed: false })

    const toastId = (id: string) => `import:${id}`

    function dismiss(id: string): void {
        dismissing.add(id)
        toast.dismiss(toastId(id))
    }

    function showCard(id: string): void {
        shown.add(id)
        minimized.delete(id)
        toast.custom(ImportProgressToast, {
            id: toastId(id),
            duration: Number.POSITIVE_INFINITY,
            componentProps: { id, onMinimize: () => minimize(id) },
            onDismiss: () => {
                if (dismissing.delete(id)) return
                // A swipe: same as the card's own X.
                collapse(id)
            },
        })
    }

    function minimize(id: string): void {
        dismiss(id)
        collapse(id)
    }

    function collapse(id: string): void {
        shown.delete(id)
        const entry = get(importTasks).get(id)
        if (entry && (entry.phase === 'queued' || entry.phase === 'running')) minimized.add(id)
        refreshPill()
    }

    function restoreAll(): void {
        for (const id of [...minimized]) {
            if (get(importTasks).has(id)) showCard(id)
            else minimized.delete(id)
        }
        refreshPill()
    }

    function refreshPill(): void {
        const tasks = get(importTasks)
        let count = 0
        let sum = 0
        let measured = 0
        let failed = false
        for (const id of minimized) {
            const entry = tasks.get(id)
            if (!entry) continue
            count++
            if (entry.phase === 'failed') failed = true
            if (entry.progress !== null) {
                sum += entry.progress
                measured++
            }
        }
        pill = { count, progress: measured > 0 ? Math.round(sum / measured) : null, failed }
    }

    function scheduleDismiss(id: string, failed: boolean): void {
        if (dismissTimers.has(id)) return
        const timer = setTimeout(() => {
            dismissTimers.delete(id)
            minimized.delete(id)
            if (shown.delete(id)) dismiss(id)
            clearImportTask(id)
            refreshPill()
        }, failed ? 8000 : 2500)
        dismissTimers.set(id, timer)
    }

    const unsubscribe = importTasks.subscribe((tasks) => {
        for (const [id, entry] of tasks) {
            // A failure shows its card again, so the error is not missed.
            if (entry.phase === 'failed' && minimized.has(id)) showCard(id)
            if (!shown.has(id) && !minimized.has(id) && !dismissTimers.has(id)) showCard(id)
            if (entry.phase === 'done' || entry.phase === 'failed') {
                scheduleDismiss(id, entry.phase === 'failed')
            }
        }

        for (const id of [...shown]) {
            if (!tasks.has(id) && !dismissTimers.has(id)) {
                shown.delete(id)
                dismiss(id)
            }
        }
        for (const id of [...minimized]) {
            if (!tasks.has(id)) minimized.delete(id)
        }
        refreshPill()
    })

    onDestroy(() => {
        unsubscribe()
        for (const timer of dismissTimers.values()) clearTimeout(timer)
        dismissTimers.clear()
    })
</script>

{#if pill.count > 0}
    <button
        type="button"
        class="fixed bottom-24 right-3 z-50 flex items-center gap-1.5 rounded-full border bg-darkbg px-3 py-1.5 text-xs font-semibold text-textcolor shadow-lg transition-colors hover:border-primary"
        class:border-darkborderc={!pill.failed}
        class:border-red-500={pill.failed}
        title={language.importProgressShow}
        aria-label={`${language.importProgressShow} (${pill.count})`}
        onclick={restoreAll}
    >
        <DownloadIcon size={14} class={pill.failed ? 'text-red-500' : 'animate-pulse text-primary'} />
        <span>{pill.count}</span>
        <span class="text-textcolor2">{pill.progress === null ? '…' : `${pill.progress}%`}</span>
    </button>
{/if}
