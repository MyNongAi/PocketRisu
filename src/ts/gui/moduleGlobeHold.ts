// MODULE-BOT-LINK-MENU: the user's request, 2026-11-20. A catalog globe's
// 500ms press links the open bot; its release must not toggle global too.
export const MODULE_GLOBE_HOLD_MS = 500
const MOVE_TOLERANCE = 8

type GlobeActions = { tap: () => void, hold: () => void, canHold: () => boolean }

export function moduleGlobeHold(button: HTMLButtonElement, actions: GlobeActions) {
    let current = actions
    let pointerId: number | null = null
    let x = 0
    let y = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let suppressClick = false

    function cancelTimer() {
        clearTimeout(timer)
        timer = undefined
    }

    function down(event: PointerEvent) {
        if (event.button !== 0 || pointerId !== null) return
        event.stopPropagation()
        cancelTimer()
        suppressClick = false
        if (!current.canHold()) return
        pointerId = event.pointerId
        x = event.clientX
        y = event.clientY
        timer = setTimeout(() => {
            timer = undefined
            if (pointerId === null) return
            suppressClick = true
            current.hold()
            try { navigator.vibrate?.(20) } catch {}
        }, MODULE_GLOBE_HOLD_MS)
    }

    function move(event: PointerEvent) {
        if (event.pointerId !== pointerId) return
        if (Math.hypot(event.clientX - x, event.clientY - y) <= MOVE_TOLERANCE) return
        cancelTimer()
        // A stroke is neither a hold nor a tap, even if touch capture later
        // routes its synthesized click back through this button.
        suppressClick = true
    }

    function end(event: PointerEvent) {
        if (event.pointerId !== pointerId) return
        event.stopPropagation()
        cancelTimer()
        pointerId = null
    }

    function cancel(event: PointerEvent) {
        if (event.pointerId !== pointerId) return
        suppressClick = true
        end(event)
    }

    function leave(event: PointerEvent) {
        if (event.pointerId !== pointerId) return
        cancelTimer()
        suppressClick = true
    }

    function click(event: MouseEvent) {
        event.stopPropagation()
        if (suppressClick) {
            event.preventDefault()
            suppressClick = false
            return
        }
        current.tap()
    }

    function contextMenu(event: MouseEvent) {
        if (pointerId === null && !suppressClick) return
        event.preventDefault()
        event.stopPropagation()
    }

    button.addEventListener('pointerdown', down)
    button.addEventListener('pointermove', move)
    button.addEventListener('pointerup', end)
    button.addEventListener('pointercancel', cancel)
    button.addEventListener('pointerleave', leave)
    button.addEventListener('click', click)
    button.addEventListener('contextmenu', contextMenu)

    return {
        update(next: GlobeActions) { current = next },
        destroy() {
            cancelTimer()
            button.removeEventListener('pointerdown', down)
            button.removeEventListener('pointermove', move)
            button.removeEventListener('pointerup', end)
            button.removeEventListener('pointercancel', cancel)
            button.removeEventListener('pointerleave', leave)
            button.removeEventListener('click', click)
            button.removeEventListener('contextmenu', contextMenu)
        },
    }
}
