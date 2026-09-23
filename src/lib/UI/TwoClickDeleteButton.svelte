<script lang="ts">
    import { TrashIcon } from '@lucide/svelte'
    import { onDestroy } from 'svelte'

    interface Props {
        onConfirm: () => void | Promise<void>
        label?: string
        size?: number
        className?: string
    }

    let {
        onConfirm,
        label = 'Delete',
        size = 24,
        className = '',
    }: Props = $props()

    let armed = $state(false)
    let resetTimer: ReturnType<typeof setTimeout> | undefined

    function reset() {
        armed = false
        if (resetTimer) clearTimeout(resetTimer)
        resetTimer = undefined
    }

    function handleClick(event: MouseEvent) {
        event.stopPropagation()
        if (!armed) {
            armed = true
            resetTimer = setTimeout(reset, 2_000)
            return
        }

        reset()
        void onConfirm()
    }

    onDestroy(reset)
</script>

<button
    type="button"
    class="touch-manipulation rounded-sm p-0.5 transition-colors {armed ? 'text-red-400 bg-red-500/15' : ''} {className}"
    title={`${label} · ${armed ? '2/2' : '1/2'}`}
    aria-label={`${label} · ${armed ? '2/2' : '1/2'}`}
    aria-pressed={armed}
    onclick={handleClick}
>
    <TrashIcon {size} />
</button>
