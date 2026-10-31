import { afterEach, describe, expect, it, vi } from 'vitest'
import { markSortableDrag, menuTriggerProps, sortableDragActive, sortableFilter } from './holdDrag'

function press(html: string, selector: string, pointerType: string) {
    document.body.innerHTML = html
    const target = document.querySelector(selector)!
    return { type: 'pointerdown', pointerType, target } as unknown as Event
}

const row = `<div data-sortable-key="a"><span class="name">A</span>
  <button class="no-sort" data-hold-drag aria-label="menu"><i class="icon"></i></button>
  <input class="no-sort" /></div>`

afterEach(() => {
    vi.useRealTimers()
    markSortableDrag(false)
})

describe('a held ⋮ drags its row', () => {
    it('lets a touch on the ⋮ (or its icon) drag, but not a mouse', () => {
        expect(sortableFilter(press(row, '.icon', 'touch'))).toBe(false)
        expect(sortableFilter(press(row, 'button', 'touch'))).toBe(false)
        expect(sortableFilter(press(row, 'button', 'mouse'))).toBe(true)
    })

    it('keeps other .no-sort parts out of a drag, and the row itself draggable', () => {
        expect(sortableFilter(press(row, 'input', 'touch'))).toBe(true)
        expect(sortableFilter(press(row, '.name', 'touch'))).toBe(false)
        expect(sortableFilter(press(row, '.name', 'mouse'))).toBe(false)
    })

    it('does not open the menu on the release of a drag, but does on a tap', () => {
        vi.useFakeTimers()
        const open = vi.fn()
        const props = menuTriggerProps({ onpointerup: open })
        const up = () => ({ preventDefault: vi.fn() }) as unknown as PointerEvent

        markSortableDrag(true)
        props.onpointerup(up())
        expect(open).not.toHaveBeenCalled()
        markSortableDrag(false)
        expect(sortableDragActive()).toBe(true)
        vi.advanceTimersByTime(500)
        expect(sortableDragActive()).toBe(false)
        props.onpointerup(up())
        expect(open).toHaveBeenCalledTimes(1)
    })
})
