// A touch opens a list's folder, row or ⋮ menu only when it is a tap: short
// and nearly still (the user's request, 2026-11-18: scrolling the phone's
// side panel Module tab, a light stroke over a folder or a ⋮ opened it). A
// finger that strokes past TAP_SLOP_PX or stays longer than TAP_MAX_MS opens
// nothing. Mouse and keyboard are not affected.
//
// One press is tracked at a time (one finger works a list): the list notes
// it in the capture phase (touchPressStart / touchPressMove), and the click
// or release that ends it asks isStrayTouch.

export const TAP_MAX_MS = 400
export const TAP_SLOP_PX = 8

type Press = { x: number, y: number, at: number, moved: boolean }
let press: Press | null = null

type PointerLike = { pointerType?: string, clientX: number, clientY: number, timeStamp: number }

/** A press begins (pointerdown); only a touch is tracked. */
export function touchPressStart(event: PointerLike): void {
    press = event.pointerType === 'touch'
        ? { x: event.clientX, y: event.clientY, at: event.timeStamp, moved: false }
        : null
}

/** The pressing finger moves (pointermove). */
export function touchPressMove(event: PointerLike): void {
    if (!press || event.pointerType !== 'touch') return
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP_PX) press.moved = true
}

/**
 * Whether the touch this event ends (its pointerup or click) stroked or
 * lingered, so it is not a tap. False for a mouse, a keyboard click, or no
 * tracked press.
 */
export function isStrayTouch(event: { pointerType?: string, timeStamp: number }): boolean {
    if (event.pointerType !== 'touch' || !press) return false
    return press.moved || event.timeStamp - press.at > TAP_MAX_MS
}
