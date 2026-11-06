import { afterEach, describe, expect, it, vi } from 'vitest'
import Sortable from 'sortablejs'
import { markSortableDrag, menuTriggerProps, sortableFilter } from './holdDrag'
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
    const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', button: 0, clientX: x, clientY: 10 })
    row.dispatchEvent(event)
    return event
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
        vi.useFakeTimers()
        markSortableDrag(false)
        vi.advanceTimersByTime(400)
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

    it.each([100, 700])('opens just the button menu on a still release after %i ms', (duration) => {
        vi.useFakeTimers()
        initSortableTouchHold()
        const el = list()
        const first = el.children[0]
        first.innerHTML = '<button class="no-sort" data-hold-drag><span>menu</span></button>'
        const button = first.querySelector('button')!
        const icon = button.firstElementChild!
        const open = vi.fn()
        const props = menuTriggerProps({
            style: '',
            onpointerdown: (event: PointerEvent) => event.preventDefault(),
            onpointerup: open,
        })
        button.style.cssText = props.style
        button.addEventListener('pointerdown', props.onpointerdown)
        button.addEventListener('pointerup', props.onpointerup)
        made.push(chromeLike(Sortable.create(el, { ...sortableOptions, filter: sortableFilter, preventOnFilter: false })))

        expect(press(icon, 'pointerdown').defaultPrevented).toBe(false)
        expect(Sortable.dragged).toBe(first)
        vi.advanceTimersByTime(duration)
        expect(open).not.toHaveBeenCalled()
        expect(first.classList.contains('sortable-chosen')).toBe(duration >= 300)
        press(icon, 'pointerup')
        expect(open).toHaveBeenCalledOnce()
        expect(Sortable.dragged).toBeNull()
    })

    it('drags from a nested menu icon after the hold and suppresses its release menu', () => {
        vi.useFakeTimers()
        initSortableTouchHold()
        const el = list()
        const first = el.children[0]
        first.innerHTML = '<button class="no-sort" data-hold-drag><span>menu</span></button>'
        const button = first.querySelector('button')!
        const icon = button.firstElementChild!
        const open = vi.fn()
        const started = vi.fn(() => markSortableDrag(true))
        const ended = vi.fn(() => markSortableDrag(false))
        const props = menuTriggerProps({
            onpointerdown: (event: PointerEvent) => event.preventDefault(),
            onpointerup: open,
        })
        button.addEventListener('pointerdown', props.onpointerdown)
        button.addEventListener('pointerup', props.onpointerup)
        const sortable = chromeLike(Sortable.create(el, {
            ...sortableOptions, filter: sortableFilter, preventOnFilter: false, onStart: started, onEnd: ended,
        }))
        made.push(sortable)

        press(icon, 'pointerdown')
        press(icon, 'pointermove', 12)
        vi.advanceTimersByTime(300)
        expect(first.classList.contains('sortable-chosen')).toBe(true)
        press(icon, 'pointermove', 30)
        vi.advanceTimersByTime(0)
        expect(Sortable.active).toBe(sortable)
        expect(started).toHaveBeenCalledOnce()
        expect(open).not.toHaveBeenCalled()
        press(icon, 'pointerup')
        expect(ended).toHaveBeenCalledOnce()
        expect(open).not.toHaveBeenCalled()
        expect(Sortable.dragged).toBeNull()
        // A late pointerup after the drop must not open a menu either.
        press(icon, 'pointerup')
        expect(open).not.toHaveBeenCalled()
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
