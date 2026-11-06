import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isHoldDragTouch, markSortableDrag, menuTriggerClick, menuTriggerProps, sortableDragActive, sortableFilter } from './holdDrag'

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
    it('lets a touch or a mouse on the ⋮ (or its icon) drag the row', () => {
        expect(sortableFilter(press(row, '.icon', 'touch'))).toBe(false)
        expect(sortableFilter(press(row, 'button', 'touch'))).toBe(false)
        expect(sortableFilter(press(row, 'button', 'mouse'))).toBe(false)
        expect(sortableFilter(press(row, '.icon', 'mouse'))).toBe(false)
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

        // A mouse press may start a drag too; the menu opens on its click.
        const mouse = new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true, cancelable: true })
        button.dispatchEvent(mouse)
        expect(down).not.toHaveBeenCalled()
        expect(mouse.defaultPrevented).toBe(false)
        expect(bubbled).toHaveBeenCalledTimes(2)

        const pen = new PointerEvent('pointerdown', { pointerType: 'pen', bubbles: true, cancelable: true })
        button.dispatchEvent(pen)
        expect(down).toHaveBeenCalledOnce()
    })

    it('suppresses native touch context menus; a mouse right-click opens this menu only', () => {
        press(row, 'button', 'touch')
        const context = vi.fn()
        const open = vi.fn()
        const rowMenu = vi.fn()
        const props = menuTriggerProps({ oncontextmenu: context, onpointerdown: open })
        const button = document.querySelector('button')!
        button.addEventListener('pointerdown', props.onpointerdown)
        button.addEventListener('contextmenu', props.oncontextmenu)
        button.parentElement!.addEventListener('contextmenu', rowMenu)
        const touch = new PointerEvent('contextmenu', { pointerType: 'touch', bubbles: true, cancelable: true })
        document.querySelector('.icon')!.dispatchEvent(touch)
        expect(touch.defaultPrevented).toBe(true)
        expect(context).not.toHaveBeenCalled()
        // The row ignores a touch contextmenu on ⋮ itself (ShContextMenu).
        rowMenu.mockClear()

        button.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true, cancelable: true, button: 2 }))
        const mouse = new PointerEvent('contextmenu', { pointerType: 'mouse', bubbles: true, cancelable: true, button: 2 })
        button.dispatchEvent(mouse)
        expect(mouse.defaultPrevented).toBe(true)
        expect(rowMenu).not.toHaveBeenCalled()
        expect(context).not.toHaveBeenCalled()
        expect(open).toHaveBeenCalledOnce()
        expect(open.mock.calls[0][0]).toMatchObject({ pointerType: 'mouse', button: 0 })
    })

    it('opens on a mouse click, not on the press, and keeps keyboard and touch clicks with bits-ui', () => {
        press(row, 'button', 'mouse')
        const open = vi.fn()
        const click = vi.fn()
        const raw = { onpointerdown: open, onclick: click }
        const props = menuTriggerProps(raw)
        const button = document.querySelector('button')!
        const rowClick = vi.fn()
        button.parentElement!.addEventListener('click', rowClick)
        button.addEventListener('pointerdown', props.onpointerdown)
        button.addEventListener('click', (e) => menuTriggerClick(raw, e))

        button.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true, cancelable: true }))
        expect(open).not.toHaveBeenCalled()
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
        expect(open).toHaveBeenCalledOnce()
        expect(click).not.toHaveBeenCalled()
        expect(rowClick).not.toHaveBeenCalled()

        // The click that ends a mouse drag opens nothing.
        markSortableDrag(true)
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
        expect(open).toHaveBeenCalledOnce()
        markSortableDrag(false)
        vi.advanceTimersByTime(400)

        // Keyboard (detail 0) and touch clicks stay with bits-ui's own handlers.
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }))
        expect(click).toHaveBeenCalledOnce()
        button.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true, cancelable: true }))
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
        expect(click).toHaveBeenCalledTimes(2)
        expect(open).toHaveBeenCalledOnce()
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
