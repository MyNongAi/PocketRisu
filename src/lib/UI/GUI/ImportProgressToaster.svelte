<script lang="ts">
    import { onDestroy } from 'svelte'
    import { get } from 'svelte/store'
    import { toast } from 'svelte-sonner'
    import { clearImportTask, importTasks } from 'src/ts/importProgress'
    import { importDockPill, setImportDockRestore } from 'src/ts/importDock'
    import ImportProgressToast from './ImportProgressToast.svelte'

    const shown = new Set<string>()
    const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>()
    // Tasks whose card the user folded (its "-", or a swipe) while they still
    // run: they collapse into the small button below, which brings them back.
    const minimized = new Set<string>()
    // Our own dismissals, so they are not taken for the user's.
    const dismissing = new Set<string>()
    // Cards the user closed with "×" while the task goes on: not shown again.
    const closed = new Set<string>()
    // The folded cards' button lives in the request dock's column (importDock.ts).
    setImportDockRestore(() => restoreAll())

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
            componentProps: { id, onMinimize: () => minimize(id), onClose: () => closeCard(id) },
            onDismiss: () => {
                if (dismissing.delete(id)) return
                // A swipe: same as the card's own "-" (fold, keep running).
                collapse(id)
            },
        })
    }

    function closeCard(id: string): void {
        closed.add(id)
        shown.delete(id)
        minimized.delete(id)
        dismiss(id)
        refreshPill()
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
        importDockPill.set({ count, progress: measured > 0 ? Math.round(sum / measured) : null, failed })
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
            // A failure or a rollback shows its card again, so its summary is not missed.
            if ((entry.phase === 'failed' || entry.phase === 'cancelled') && minimized.has(id)) showCard(id)
            if (!shown.has(id) && !minimized.has(id) && !dismissTimers.has(id) && !closed.has(id)) showCard(id)
            if (entry.phase === 'done' || entry.phase === 'failed' || entry.phase === 'cancelled') {
                // A cancelled card can carry a rollback summary: keep it up like a failure.
                scheduleDismiss(id, entry.phase !== 'done')
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
        for (const id of [...closed]) {
            if (!tasks.has(id)) closed.delete(id)
        }
        refreshPill()
    })

    onDestroy(() => {
        unsubscribe()
        for (const timer of dismissTimers.values()) clearTimeout(timer)
        dismissTimers.clear()
        importDockPill.set({ count: 0, progress: null, failed: false })
        setImportDockRestore(() => {})
    })
</script>
