// Holding a row of a Sortable list on a phone to drag it (the user's report,
// 2026-10-28: modules still would not move on the phone after the 10-26 fix
// in ShContextMenu). Sortable (1.15.6) lifts a row after its touch delay
// (sortableOptions: 300ms), and two of its ways broke that on a real finger,
// which a synthetic, perfectly still touch never showed:
// - Any move while held let go of the row. Sortable forces
//   touchStartThreshold to 1 where rows can drag natively and then divides
//   it by the pixel ratio, which leaves 0px; a finger always trembles.
// - The browser then took the press as a scroll and ended it with
//   pointercancel, which Sortable does not listen for there: the row stayed
//   picked up inside Sortable, and every later press on any list was ignored
//   until a plain tap somewhere ended it.
// A plugin on every list sets the tolerance as each press starts, and a
// press the browser cancels before the row is lifted is let go of.

import Sortable from 'sortablejs'

/** How far a held finger may wander before the press counts as a scroll, in CSS px. */
export const TOUCH_HOLD_SLOP_PX = 8

type SortableWithDrop = Sortable & { _onDrop(): void }

// The list a touch press is held on, until its row is lifted or let go of.
let heldOn: SortableWithDrop | null = null
let installed = false

function isTouch(event: unknown): boolean {
    const e = event as { pointerType?: string, touches?: unknown } | undefined
    return !!e && (e.pointerType === 'touch' || !!e.touches)
}

/** Sortable divides the threshold by the pixel ratio where rows drag natively. */
export function touchHoldThreshold(pixelRatio: number): number {
    return TOUCH_HOLD_SLOP_PX * (pixelRatio || 1)
}

function SteadyTouchHold(this: unknown) {}
SteadyTouchHold.prototype = {
    delayStartGlobal({ sortable, originalEvent }: { sortable: SortableWithDrop, originalEvent?: unknown }) {
        sortable.options.touchStartThreshold = touchHoldThreshold(window.devicePixelRatio)
        heldOn = isTouch(originalEvent) ? sortable : null
    },
    delayEndedGlobal() {
        heldOn = null
    },
}

/** The browser cancelled a held press before its row was lifted. */
export function letGoOfCancelledHold(event: { pointerType?: string }): void {
    const sortable = heldOn
    heldOn = null
    if (!sortable || event.pointerType !== 'touch') return
    const row = Sortable.dragged
    if (!row || Sortable.active) return
    sortable._onDrop()
    row.style.removeProperty('will-change')
}

/** Before the app mounts: plugins reach only the lists made after. */
export function initSortableTouchHold(): void {
    if (installed) return
    installed = true
    Sortable.mount(Object.assign(SteadyTouchHold, { pluginName: 'steadyTouchHold', initializeByDefault: true }) as never)
    document.addEventListener('pointercancel', letGoOfCancelledHold, true)
    document.addEventListener('pointerup', () => { heldOn = null }, true)
}
