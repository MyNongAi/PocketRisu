<script lang="ts">
    // A right triangle in a text field's bottom right corner (the user's
    // requests, 2026-10-17 and 2026-10-26). Dragging it changes the field's
    // height with pointer events, so touch works too, unlike CSS resize. The
    // field never goes below its own minimum; a drag that ends there, or a
    // double tap, goes back to the default height. With a storage key the
    // height is remembered on this device, otherwise while the field is shown.
    // The parent must be positioned: the corner sits in its bottom right.
    import { untrack } from 'svelte'
    import { language } from 'src/lang'
    import { draggedFieldHeight, readStoredFieldHeight, storeFieldHeight } from 'src/ts/gui/fieldHeight'

    interface Props {
        /** The field to resize, null while it is not there yet; the element just before the corner when left out. */
        target?: HTMLElement | null
        /** Remembers the height on this device under this key. */
        storageKey?: string
        class?: string
    }
    let { target = undefined, storageKey = undefined, class: className = '' }: Props = $props()

    let corner = $state<HTMLDivElement>()
    const field = $derived(target === undefined ? (corner?.previousElementSibling as HTMLElement | null) ?? null : target)

    // A field in a column that is full (the sidebar's settings) would shrink
    // back to its minimum, so a dragged one does not shrink.
    function apply(height: number | null) {
        if (!field) return
        field.style.height = height ? `${height}px` : ''
        field.style.flexShrink = height ? '0' : ''
    }

    $effect(() => {
        if (!field || !storageKey) return
        const height = readStoredFieldHeight(storageKey)
        if (height) untrack(() => apply(height))
    })

    function start(event: PointerEvent) {
        const el = field
        if (!el || !corner) return
        event.preventDefault()
        const startY = event.clientY
        const startHeight = el.getBoundingClientRect().height
        const minHeight = parseFloat(getComputedStyle(el).minHeight) || 80
        let height: number | null = null
        let moved = false
        corner.setPointerCapture?.(event.pointerId)
        const move = (moveEvent: PointerEvent) => {
            moved = true
            height = draggedFieldHeight(startHeight, moveEvent.clientY - startY, minHeight)
            apply(height)
        }
        const stop = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', stop)
            window.removeEventListener('pointercancel', stop)
            if (moved) storeFieldHeight(storageKey, height)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', stop)
        window.addEventListener('pointercancel', stop)
    }

    function reset() {
        apply(null)
        storeFieldHeight(storageKey, null)
    }
</script>

<div
    bind:this={corner}
    role="separator"
    aria-orientation="horizontal"
    aria-label={language.textAreaResize}
    title={language.textAreaResize}
    class="resize-corner text-textcolor2 hover:text-textcolor {className}"
    data-resize-corner
    onpointerdown={start}
    ondblclick={reset}
></div>

<style>
    .resize-corner {
        position: absolute;
        right: 0;
        bottom: 0;
        width: 1.25rem;
        height: 1.25rem;
        cursor: ns-resize;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
    }
    /* The triangle itself: its right angle sits in the field's corner. */
    .resize-corner::after {
        content: '';
        position: absolute;
        right: 3px;
        bottom: 3px;
        width: 9px;
        height: 9px;
        background: currentColor;
        border-bottom-right-radius: 2px;
        clip-path: polygon(100% 0, 100% 100%, 0 100%);
    }
    /* A finger needs more to hold on to than the triangle shows. */
    @media (pointer: coarse) {
        .resize-corner {
            width: 1.75rem;
            height: 1.75rem;
        }
    }
</style>
