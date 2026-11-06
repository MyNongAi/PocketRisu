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

function press(row: Element, type: string, x = 10, y = 10) {
    const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', button: 0, clientX: x, clientY: y })
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
        if (!vi.isFakeTimers()) vi.useFakeTimers()
        markSortableDrag(false)
        vi.advanceTimersByTime(400)
        vi.useRealTimers()
        for (const sortable of made.splice(0)) sortable.destroy()
        vi.restoreAllMocks()
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

    // The FolderedList topology: an outer folder Sortable, with independent
    // item Sortables for each run of root rows and each expanded folder.
    function folderedLists(nativeDraggable: boolean) {
        const outer = document.createElement('div')
        outer.innerHTML = `
            <div data-folder-container=""><div data-items><div data-key="root-a">root a</div></div></div>
            <div data-folder-key="a"><header>Alpha</header><div data-folder-container="a"><div data-items><div data-key="folder-a">folder a</div></div></div></div>
            <div data-folder-container=""><div data-items><div data-key="root-b">root b</div></div></div>
            <div data-folder-key="b"><header>Beta</header><div data-folder-container="b"><div data-items><div class="no-sort">Empty</div></div></div></div>`
        document.body.append(outer)
        const ended = vi.fn()
        const options = {
            ...sortableOptions, draggable: '[data-key]', filter: sortableFilter,
            preventOnFilter: false, onMove: (event: Sortable.MoveEvent) => !event.related.className.includes('no-sort'),
            onEnd: ended, scroll: false,
        }
        function create(el: HTMLElement, opts: Sortable.Options) {
            const sortable = Sortable.create(el, opts)
            if (nativeDraggable) chromeLike(sortable)
            // happy-dom has no native draggable support at module initialization;
            // wire the native dragover listener the constructor adds in a browser.
            el.addEventListener('dragover', sortable as unknown as EventListenerObject)
            made.push(sortable)
            return sortable
        }
        create(outer, { ...options, draggable: '[data-folder-key]', group: 'foldered-list-folders' })
        const lists = Array.from(outer.querySelectorAll<HTMLElement>('[data-items]'))
        lists.forEach((el, index) => {
            el.style.cssText = 'display: flex; flex-direction: column;'
            const rect = new DOMRect(0, index * 100, 300, 60)
            vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect)
            for (const row of el.children) {
                vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect)
                if (row.matches('[data-key]')) {
                    row.innerHTML += '<button class="no-sort" data-hold-drag><span>menu</span></button>'
                }
            }
            create(el, {
                ...options, group: { name: 'foldered-list-items', pull: true, put: true }, emptyInsertThreshold: 32,
                fallbackOnBody: true,
            })
        })
        return { outer, lists, ended }
    }

    const crossListMoves = [
        ['past a folder into the next root group', 0, 2],
        ['out of a folder into the root', 1, 2],
        ['into an expanded folder', 0, 1],
        ['into an empty expanded folder', 0, 3],
        ['from one folder into another', 1, 3],
    ] as const
    it.each(crossListMoves.flatMap(([name, from, to]) => (['touch', 'mouse'] as const).map((input) => ({ name, from, to, input }))))('$input-drags $name', ({ from, to, input }) => {
        vi.useFakeTimers()
        initSortableTouchHold()
        const { lists, ended } = folderedLists(input === 'mouse')
        const source = lists[from]
        const destination = lists[to]
        const row = source.firstElementChild!
        const icon = input === 'touch' ? row.querySelector('span')! : row
        let hit: Element = icon
        // happy-dom has no layout/hit testing: this covers Sortable's cross-list
        // dispatch, not whether a real phone's preview obscures the target.
        vi.spyOn(document, 'elementFromPoint').mockImplementation(() => hit)
        icon.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, pointerType: input, button: 0, clientX: 10, clientY: from * 100 + 10,
        }))
        if (input === 'touch') {
            vi.advanceTimersByTime(300)
            press(icon, 'pointermove', 20, from * 100 + 12)
        } else {
            row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
        }
        vi.advanceTimersByTime(0)
        expect(Sortable.active).toBe(Sortable.get(source))
        if (input === 'touch') expect(Sortable.ghost?.parentElement).toBe(document.body)
        else expect(Sortable.ghost).toBeNull()
        // The finger crosses the header (a different Sortable group) first.
        hit = lists[1].closest('[data-folder-key]')!.querySelector('header')!
        if (input === 'touch') press(icon, 'pointermove', 30, 90)
        else hit.dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientX: 30, clientY: 90 }))
        vi.advanceTimersByTime(50)
        expect(row.parentElement).toBe(source)
        hit = destination.firstElementChild!
        // happy-dom aliases DragEvent to Event; MouseEvent supplies dragover coordinates.
        const event = input === 'touch' ? new PointerEvent('pointermove', {
            bubbles: true, cancelable: true, pointerType: 'touch', clientX: 30, clientY: to * 100 + 45,
        }) : new MouseEvent('dragover', { bubbles: true, cancelable: true, clientX: 30, clientY: to * 100 + 45 })
        ;(input === 'touch' ? icon : hit).dispatchEvent(event)
        vi.advanceTimersByTime(50)
        expect(row.parentElement).toBe(destination)
        if (input === 'touch') press(icon, 'pointerup')
        else row.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }))
        expect(ended).toHaveBeenCalledOnce()
        expect(ended.mock.calls[0][0]).toMatchObject({ from: source, to: destination, item: row })
    })
})
