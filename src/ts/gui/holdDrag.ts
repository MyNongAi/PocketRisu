// A row's ⋮ menu button drags the row when held on a touch screen (the
// user's request, 2026-10-31: "세로 ... 3개 우측에 달린거 홀드하면
// 드래그앤드랍되게"); a tap still opens the menu. The button keeps its
// `.no-sort` class, so a mouse press only opens the menu as before (a mouse
// drags from the row itself), and is marked with `data-hold-drag`.
//
// The menu (bits-ui) opens on a touch's pointerup, which comes after the
// drop as well; while a drag runs, and a moment after, that pointerup is
// swallowed (menuTriggerProps).

export const HOLD_DRAG_ATTRIBUTE = 'data-hold-drag'

/** The marked button owns a touch press, including one on its nested icon. */
export function isHoldDragTouch(event: Event): boolean {
    const touch = (event as PointerEvent).pointerType === 'touch' || event.type === 'touchstart'
    const target = event.target as Element | null
    return touch && !!target?.closest?.(`[${HOLD_DRAG_ATTRIBUTE}]`)
}

/** Sortable's filter: `.no-sort` stays put, but a touch on a hold-drag ⋮ may drag. */
export function sortableFilter(event: Event): boolean {
    const target = event.target as Element | null
    if (!target?.closest?.('.no-sort')) return false
    return !isHoldDragTouch(event)
}

let dragging = false
let releaseTimer: ReturnType<typeof setTimeout> | undefined

/** Called by the sortable lists as a drag starts and ends. */
export function markSortableDrag(active: boolean): void {
    clearTimeout(releaseTimer)
    if (active) {
        dragging = true
        return
    }
    // The release's pointerup and click land after the drop.
    releaseTimer = setTimeout(() => { dragging = false }, 400)
}

export function sortableDragActive(): boolean {
    return dragging
}

/** A menu trigger's props that do not open the menu on the release of a drag. */
export function menuTriggerProps<T extends Record<string, unknown>>(props: T): T {
    const pointerDown = props.onpointerdown as ((event: PointerEvent) => void) | undefined
    const pointerUp = props.onpointerup as ((event: PointerEvent) => void) | undefined
    const contextMenu = props.oncontextmenu as ((event: MouseEvent) => void) | undefined
    return {
        ...props,
        // This must be set before contact: changing it on pointerdown is too late
        // to keep the browser from taking over a held finger as a pan/cancel.
        style: `${props.style ?? ''}; touch-action: none;`,
        onpointerdown: (event: PointerEvent) => {
            // bits-ui prevents the touch pointerdown's default. Leave the press
            // to Sortable and keep bits-ui's touch pointerup for taps/still holds.
            if (!isHoldDragTouch(event)) pointerDown?.(event)
        },
        oncontextmenu: (event: MouseEvent) => {
            if (isHoldDragTouch(event)) {
                event.preventDefault()
                return
            }
            contextMenu?.(event)
        },
        onpointerup: (event: PointerEvent) => {
            if (dragging) {
                event.preventDefault()
                return
            }
            pointerUp?.(event)
        },
    }
}
