import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isHoldDragTouch, markSortableDrag, menuTriggerProps, sortableDragActive, sortableFilter } from './holdDrag'

function press(html: string, selector: string, pointerType: string) {
    document.body.innerHTML = html
    const target = document.querySelector(selector)!
    return { type: 'pointerdown', pointerType, target } as unknown as Event
}

const row = `<div data-sortable-key="a"><span class="name">A</span>
  <button class="no-sort" data-hold-drag aria-label="menu"><i class="icon"></i></button>
  <input class="no-sort" /></div>`

beforeEach(() => {
    vi.useFakeTimers()
    markSortableDrag(false)
    vi.advanceTimersByTime(400)
})
afterEach(() => {
    markSortableDrag(false)
    vi.advanceTimersByTime(400)
    vi.useRealTimers()
    document.body.innerHTML = ''
})

describe('a held ⋮ drags its row', () => {
    it('lets a touch on the ⋮ (or its icon) drag, but not a mouse', () => {
        expect(sortableFilter(press(row, '.icon', 'touch'))).toBe(false)
        expect(sortableFilter(press(row, 'button', 'touch'))).toBe(false)
        expect(sortableFilter(press(row, 'button', 'mouse'))).toBe(true)
    })

    it('gives only marked touch presses to the menu, not the row context menu', () => {
        expect(isHoldDragTouch(press(row, '.icon', 'touch'))).toBe(true)
        expect(isHoldDragTouch(press(row, 'button', 'touch'))).toBe(true)
        expect(isHoldDragTouch(press(row, 'button', 'mouse'))).toBe(false)
        expect(isHoldDragTouch(press(row, 'button', 'pen'))).toBe(false)
        expect(isHoldDragTouch(press(row, '.name', 'touch'))).toBe(false)
        expect(isHoldDragTouch(press(row, 'input', 'touch'))).toBe(false)
        expect(isHoldDragTouch(new Event('pointerdown'))).toBe(false)
        const touchStart = { ...press(row, '.icon', ''), type: 'touchstart' } as Event
        expect(isHoldDragTouch(touchStart)).toBe(true)
        expect(sortableFilter(touchStart)).toBe(false)
    })

    it('leaves touch-down uncancelled and bubbling, while preserving mouse handlers and props', () => {
        press(row, 'button', 'touch')
        const button = document.querySelector('button')!
        const down = vi.fn((event: PointerEvent) => { event.preventDefault(); event.stopPropagation() })
        const bubbled = vi.fn()
        const props = menuTriggerProps({ onpointerdown: down, style: 'color: red', 'aria-label': 'menu' })
        button.style.cssText = props.style
        button.addEventListener('pointerdown', props.onpointerdown)
        button.parentElement!.addEventListener('pointerdown', bubbled)

        const touch = new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true, cancelable: true })
        document.querySelector('.icon')!.dispatchEvent(touch)
        expect(touch.defaultPrevented).toBe(false)
        expect(bubbled).toHaveBeenCalledOnce()
        expect(down).not.toHaveBeenCalled()
        expect(props.style).toContain('touch-action: none')
        expect(button.style.color).toBe('red')
        expect(props['aria-label']).toBe('menu')

        const mouse = new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true, cancelable: true })
        button.dispatchEvent(mouse)
        expect(down).toHaveBeenCalledOnce()
        expect(mouse.defaultPrevented).toBe(true)
        expect(bubbled).toHaveBeenCalledOnce()
    })

    it('suppresses native touch context menus, while leaving mouse right-clicks alone', () => {
        press(row, 'button', 'touch')
        const context = vi.fn()
        const props = menuTriggerProps({ oncontextmenu: context })
        const button = document.querySelector('button')!
        button.addEventListener('contextmenu', props.oncontextmenu)
        const touch = new PointerEvent('contextmenu', { pointerType: 'touch', bubbles: true, cancelable: true })
        document.querySelector('.icon')!.dispatchEvent(touch)
        expect(touch.defaultPrevented).toBe(true)
        expect(context).not.toHaveBeenCalled()
        const mouse = new PointerEvent('contextmenu', { pointerType: 'mouse', bubbles: true, cancelable: true, button: 2 })
        button.dispatchEvent(mouse)
        expect(mouse.defaultPrevented).toBe(false)
        expect(context).toHaveBeenCalledOnce()
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
