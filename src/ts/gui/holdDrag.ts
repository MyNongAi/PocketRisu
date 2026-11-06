// A row's ⋮ menu button drags the row when held on a touch screen (the
// user's request, 2026-10-31: "세로 ... 3개 우측에 달린거 홀드하면
// 드래그앤드랍되게"); a tap still opens the menu. The button keeps its
// `.no-sort` class and is marked with `data-hold-drag`.
//
// With a mouse it works the same way since 2026-11-07 (the user: "좌우클 뭐든
// 클릭하면 팝업창 뜨고 홀드하면 드래그앤드랍으로 이동할수있게"): pressing ⋮
// and moving drags the row, and a left or right click opens the menu. bits-ui
// opens its menu on the mouse press itself, so a mouse press is kept from it
// and the click opens the menu instead (menuTriggerClick).
//
// The menu (bits-ui) opens on a touch's pointerup, which comes after the
// drop as well; while a drag runs, and a moment after, that pointerup is
// swallowed (menuTriggerProps).

export const HOLD_DRAG_ATTRIBUTE = 'data-hold-drag'

/** The press started on a row's ⋮ (or its icon). */
export function onHoldDragButton(event: Event): boolean {
    const target = event.target as Element | null
    return !!target?.closest?.(`[${HOLD_DRAG_ATTRIBUTE}]`)
}

/** The marked button owns a touch press, including one on its nested icon. */
export function isHoldDragTouch(event: Event): boolean {
    const touch = (event as PointerEvent).pointerType === 'touch' || event.type === 'touchstart'
    return touch && onHoldDragButton(event)
}

/** Sortable's filter: `.no-sort` stays put, but a row's ⋮ may drag its row. */
export function sortableFilter(event: Event): boolean {
    const target = event.target as Element | null
    if (!target?.closest?.('.no-sort')) return false
    return !onHoldDragButton(event)
}

let dragging = false
let releaseTimer: ReturnType<typeof setTimeout> | undefined
// The kind of pointer that last pressed a ⋮; its click comes after.
let lastPointerType = ''

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

type Handler<E> = ((event: E) => void) | undefined

/** Opens (or closes) a bits-ui dropdown the way its own mouse press does. */
function toggleLikeMousePress(props: Record<string, unknown>): void {
    const pointerDown = props.onpointerdown as Handler<PointerEvent>
    pointerDown?.(new PointerEvent('pointerdown', { pointerType: 'mouse', button: 0, cancelable: true }))
}

/** A menu trigger's props that do not open the menu on the press or release of a drag. */
export function menuTriggerProps<T extends Record<string, unknown>>(props: T): T {
    const pointerDown = props.onpointerdown as Handler<PointerEvent>
    const pointerUp = props.onpointerup as Handler<PointerEvent>
    const contextMenu = props.oncontextmenu as Handler<MouseEvent>
    return {
        ...props,
        // This must be set before contact: changing it on pointerdown is too late
        // to keep the browser from taking over a held finger as a pan/cancel.
        style: `${props.style ?? ''}; touch-action: none;`,
        onpointerdown: (event: PointerEvent) => {
            lastPointerType = event.pointerType
            // bits-ui prevents the touch pointerdown's default and opens on a mouse
            // press. Leave the press to Sortable; a touch tap opens on bits-ui's
            // pointerup, a mouse on the click (menuTriggerClick).
            if (isHoldDragTouch(event) || event.pointerType === 'mouse') return
            pointerDown?.(event)
        },
        oncontextmenu: (event: MouseEvent) => {
            if (isHoldDragTouch(event)) {
                event.preventDefault()
                return
            }
            if (lastPointerType === 'mouse') {
                // A right-click opens this ⋮ menu, not the row's own menu as well.
                event.preventDefault()
                event.stopPropagation()
                if (!dragging) toggleLikeMousePress(props)
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

/**
 * The ⋮'s click handler (it also keeps the click from the row). A mouse click
 * opens the menu; a keyboard click (detail 0) and a touch tap keep bits-ui's
 * own handling.
 */
export function menuTriggerClick(props: Record<string, unknown>, event: MouseEvent): void {
    event.stopPropagation()
    if (lastPointerType === 'mouse' && event.detail > 0) {
        if (!dragging) toggleLikeMousePress(props)
        return
    }
    (props.onclick as Handler<MouseEvent>)?.(event)
}
