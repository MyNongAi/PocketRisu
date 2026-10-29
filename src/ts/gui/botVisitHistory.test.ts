import { describe, expect, it, vi } from 'vitest'
import { createBotVisitHistory, installMouseHistoryButtons } from './botVisitHistory'

describe('the bots opened, stepped through like pages', () => {
    const opener = (gone: string[] = []) => vi.fn((id: string) => !gone.includes(id))

    it('steps back and forward, and a new bot drops the visits ahead', () => {
        const history = createBotVisitHistory()
        for (const id of ['a', 'b', 'c']) history.record(id)
        const open = opener()
        expect(history.step(-1, 'c', open)).toBe(true)
        expect(open).toHaveBeenLastCalledWith('b')
        expect(history.step(-1, 'b', open)).toBe(true)
        expect(history.step(-1, 'a', open)).toBe(false)
        expect(history.step(1, 'a', open)).toBe(true)
        expect(open).toHaveBeenLastCalledWith('b')
        history.record('d')
        expect(history.visits).toEqual(['a', 'b', 'd'])
        expect(history.step(1, 'd', open)).toBe(false)
    })

    it('does not record its own steps, nor the same bot twice in a row', () => {
        const history = createBotVisitHistory()
        for (const id of ['a', 'b', 'b']) history.record(id)
        // opening records like any other open would; the step must not count it
        history.step(-1, 'b', (id) => { history.record(id); return true })
        expect(history.visits).toEqual(['a', 'b'])
        expect(history.at).toBe(0)
    })

    it('skips bots that can no longer be opened', () => {
        const history = createBotVisitHistory()
        for (const id of ['a', 'gone', 'c']) history.record(id)
        const open = opener(['gone'])
        expect(history.step(-1, 'c', open)).toBe(true)
        expect(open).toHaveBeenLastCalledWith('a')
        expect(history.at).toBe(0)
    })

    it('opens the last bot again when back is pressed away from it', () => {
        const history = createBotVisitHistory()
        for (const id of ['a', 'b']) history.record(id)
        const open = opener()
        expect(history.step(-1, undefined, open)).toBe(true)
        expect(open).toHaveBeenLastCalledWith('b')
    })

    it('keeps the newest visits only', () => {
        const history = createBotVisitHistory(3)
        for (const id of ['a', 'b', 'c', 'd']) history.record(id)
        expect(history.visits).toEqual(['b', 'c', 'd'])
        expect(history.at).toBe(2)
    })
})

describe('the mouse back and forward buttons', () => {
    function press(target: EventTarget, button: number) {
        const events = ['mousedown', 'mouseup', 'auxclick'].map((type) => new MouseEvent(type, { button, cancelable: true }))
        for (const event of events) target.dispatchEvent(event)
        return events.map((event) => event.defaultPrevented)
    }

    it('steps on release and holds the page step back', () => {
        const target = new EventTarget() as unknown as Window
        const onStep = vi.fn()
        const remove = installMouseHistoryButtons(target, onStep)
        expect(press(target as unknown as EventTarget, 3)).toEqual([true, true, true])
        expect(press(target as unknown as EventTarget, 4)).toEqual([true, true, true])
        expect(onStep.mock.calls).toEqual([[-1], [1]])
        expect(press(target as unknown as EventTarget, 0)).toEqual([false, false, false])
        remove()
        expect(press(target as unknown as EventTarget, 3)).toEqual([false, false, false])
        expect(onStep).toHaveBeenCalledTimes(2)
    })
})
