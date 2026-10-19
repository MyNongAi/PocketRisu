<script lang="ts">
    // Right-click menu (a long press on touch) for one element, in the look of
    // ShDropdownMenuContent; bits-ui shares menu items between the two, so
    // `items` holds ShDropdownMenuItem rows. `trigger` gets the props to
    // spread on the element first; its own attributes after them win.
    // z-[45]: above a base-tier dialog (z-40), under the alert it may open (z-50).
    import { ContextMenu } from 'bits-ui';
    import type { Snippet } from 'svelte';
    import { cn } from 'src/lib/utils';

    interface Props {
        trigger: Snippet<[Record<string, unknown>]>;
        items: Snippet;
        disabled?: boolean;
        class?: string;
    }

    let { trigger, items, disabled = false, class: className }: Props = $props();

    // Holding the left mouse button opens the menu too (the user's request,
    // 2026-10-20), as a long press does on touch: after LONG_PRESS_MS without
    // moving, the trigger gets the contextmenu event a right-click would send,
    // and the click that ends the hold is swallowed.
    const LONG_PRESS_MS = 500
    const MOVE_TOLERANCE = 6
    let pressTimer = 0
    let pressX = 0
    let pressY = 0
    let swallowClick = false

    function cancelPress() {
        if (pressTimer) clearTimeout(pressTimer)
        pressTimer = 0
    }

    type Handler = ((event: any) => void) | undefined
    const call = (handler: unknown, event: Event) => { if (typeof handler === 'function') (handler as Handler)!(event) }

    function withMouseHold(props: Record<string, unknown>): Record<string, unknown> {
        return {
            ...props,
            onpointerdown: (event: PointerEvent) => {
                call(props.onpointerdown, event)
                swallowClick = false
                cancelPress()
                if (disabled || event.pointerType !== 'mouse' || event.button !== 0) return
                const target = event.currentTarget as HTMLElement
                pressX = event.clientX
                pressY = event.clientY
                pressTimer = window.setTimeout(() => {
                    pressTimer = 0
                    swallowClick = true
                    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: pressX, clientY: pressY }))
                }, LONG_PRESS_MS)
            },
            onpointermove: (event: PointerEvent) => {
                call(props.onpointermove, event)
                if (pressTimer && Math.hypot(event.clientX - pressX, event.clientY - pressY) > MOVE_TOLERANCE) cancelPress()
            },
            onpointerup: (event: PointerEvent) => { call(props.onpointerup, event); cancelPress() },
            onpointerleave: (event: PointerEvent) => { call(props.onpointerleave, event); cancelPress() },
            onclickcapture: (event: MouseEvent) => {
                call(props.onclickcapture, event)
                if (!swallowClick) return
                swallowClick = false
                event.preventDefault()
                event.stopImmediatePropagation()
            },
        }
    }
</script>

<ContextMenu.Root>
    <ContextMenu.Trigger {disabled} tabindex={0}>
        {#snippet child({ props })}
            {@render trigger(withMouseHold(props))}
        {/snippet}
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
        <ContextMenu.Content
            class={cn(
                'z-[45] min-w-32 rounded-md border border-darkborderc bg-darkbg text-textcolor p-1 shadow-md outline-none ' +
                'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
                'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 ' +
                'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
                className
            )}
        >
            {@render items()}
        </ContextMenu.Content>
    </ContextMenu.Portal>
</ContextMenu.Root>
