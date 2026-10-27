import { afterEach, describe, expect, it, vi } from 'vitest'
import Sortable from 'sortablejs'
import { initSortableTouchHold, letGoOfCancelledHold, touchHoldThreshold, TOUCH_HOLD_SLOP_PX } from './sortableTouchHold'

// As sortableOptions (util.ts) sets them, without pulling in the app's stores.
const sortableOptions = { delay: 300, delayOnTouchOnly: true }

function list() {
    const el = document.createElement('div')
    for (const key of ['a', 'b', 'c']) {
        const row = document.createElement('div')
        row.dataset.key = key
        row.textContent = key
        el.appendChild(row)
    }
    document.body.appendChild(el)
    return el
}

function press(row: Element, type: string, x = 10) {
    row.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', button: 0, clientX: x, clientY: 10 }))
}

// What Sortable does in Chrome, where rows can drag natively (happy-dom has no
// draggable): it listens for no pointercancel and takes 1 as the threshold.
function chromeLike(sortable: Sortable): Sortable {
    ;(sortable as Sortable & { nativeDraggable: boolean }).nativeDraggable = true
    sortable.options.touchStartThreshold = 1
    return sortable
}

describe('sortableTouchHold', () => {
    const made: Sortable[] = []
    afterEach(() => {
        vi.useRealTimers()
        for (const sortable of made.splice(0)) sortable.destroy()
        document.body.innerHTML = ''
    })

    it('lets a held finger wander a few px whatever the pixel ratio', () => {
        expect(touchHoldThreshold(1)).toBe(TOUCH_HOLD_SLOP_PX)
        expect(touchHoldThreshold(2.75) / 2.75).toBe(TOUCH_HOLD_SLOP_PX)
        expect(touchHoldThreshold(0)).toBe(TOUCH_HOLD_SLOP_PX)
    })

    it('sets the tolerance as a press starts, and lets go of a press the browser cancels', () => {
        initSortableTouchHold()
        const el = list()
        const sortable = chromeLike(Sortable.create(el, { ...sortableOptions }))
        made.push(sortable)
        const [first, second] = el.children

        press(first, 'pointerdown')
        expect(Sortable.dragged).toBe(first)
        // Sortable itself forces 1 here, which its delay check divides to 0px.
        expect(sortable.options.touchStartThreshold).toBe(touchHoldThreshold(window.devicePixelRatio))

        // The browser takes the press as a scroll: no pointerup follows.
        press(first, 'pointercancel')
        expect(Sortable.dragged).toBeNull()

        // The next press starts again instead of being ignored.
        press(second, 'pointerdown')
        expect(Sortable.dragged).toBe(second)
        press(second, 'pointerup')
        expect(Sortable.dragged).toBeNull()
    })

    it('lifts the row after the hold though the finger trembled', () => {
        vi.useFakeTimers()
        initSortableTouchHold()
        const el = list()
        made.push(chromeLike(Sortable.create(el, { ...sortableOptions })))
        const [first] = el.children
        press(first, 'pointerdown')
        press(first, 'pointermove', 12)
        vi.advanceTimersByTime(300)
        expect(first.classList.contains('sortable-chosen')).toBe(true)
        press(first, 'pointerup')
    })

    it('leaves a mouse cancel and a lifted row to Sortable', () => {
        initSortableTouchHold()
        const el = list()
        made.push(chromeLike(Sortable.create(el, { ...sortableOptions })))
        const [first] = el.children
        press(first, 'pointerdown')
        letGoOfCancelledHold({ pointerType: 'mouse' })
        expect(Sortable.dragged).toBe(first)
        press(first, 'pointerup')
        expect(Sortable.dragged).toBeNull()
    })
})
