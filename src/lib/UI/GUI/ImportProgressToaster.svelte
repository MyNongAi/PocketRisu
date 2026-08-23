<script lang="ts">
    import { onDestroy } from 'svelte'
    import { toast } from 'svelte-sonner'
    import { clearImportTask, importTasks } from 'src/ts/importProgress'
    import ImportProgressToast from './ImportProgressToast.svelte'

    const shown = new Set<string>()
    const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>()

    const toastId = (id: string) => `import:${id}`

    function scheduleDismiss(id: string, failed: boolean): void {
        if (dismissTimers.has(id)) return
        const timer = setTimeout(() => {
            dismissTimers.delete(id)
            shown.delete(id)
            toast.dismiss(toastId(id))
            clearImportTask(id)
        }, failed ? 8000 : 2500)
        dismissTimers.set(id, timer)
    }

    const unsubscribe = importTasks.subscribe((tasks) => {
        for (const [id, entry] of tasks) {
            if (!shown.has(id)) {
                shown.add(id)
                toast.custom(ImportProgressToast, {
                    id: toastId(id),
                    duration: Number.POSITIVE_INFINITY,
                    componentProps: { id },
                })
            }
            if (entry.phase === 'done' || entry.phase === 'failed') {
                scheduleDismiss(id, entry.phase === 'failed')
            }
        }

        for (const id of [...shown]) {
            if (!tasks.has(id) && !dismissTimers.has(id)) {
                shown.delete(id)
                toast.dismiss(toastId(id))
            }
        }
    })

    onDestroy(() => {
        unsubscribe()
        for (const timer of dismissTimers.values()) clearTimeout(timer)
        dismissTimers.clear()
    })
</script>
