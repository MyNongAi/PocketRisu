import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MODULE_GLOBE_HOLD_MS, moduleGlobeHold } from './moduleGlobeHold'

describe('module catalog globe hold', () => {
    let button: HTMLButtonElement
    let tap: ReturnType<typeof vi.fn<() => void>>
    let hold: ReturnType<typeof vi.fn<() => void>>
    let destroy: () => void

    function pointer(type: string, pointerType: string, x = 10, y = 10) {
        button.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, button: 0, pointerId: 1,
            pointerType, clientX: x, clientY: y,
        }))
    }

    beforeEach(() => {
        vi.useFakeTimers()
        button = document.createElement('button')
        document.body.append(button)
        tap = vi.fn<() => void>()
        hold = vi.fn<() => void>()
        destroy = moduleGlobeHold(button, { tap, hold, canHold: () => true }).destroy
    })

    afterEach(() => {
        destroy()
        button.remove()
        vi.useRealTimers()
    })

    test.each(['mouse', 'touch'])('%s tap toggles global only', (pointerType) => {
        pointer('pointerdown', pointerType)
        vi.advanceTimersByTime(MODULE_GLOBE_HOLD_MS - 1)
        pointer('pointerup', pointerType)
        button.click()
        expect(tap).toHaveBeenCalledOnce()
        expect(hold).not.toHaveBeenCalled()
    })

    test.each(['mouse', 'touch'])('%s hold links once and swallows the release click', (pointerType) => {
        pointer('pointerdown', pointerType)
        vi.advanceTimersByTime(MODULE_GLOBE_HOLD_MS)
        pointer('pointerup', pointerType)
        button.click()
        expect(hold).toHaveBeenCalledOnce()
        expect(tap).not.toHaveBeenCalled()
    })

    test('moving a finger away cancels the hold and its click', () => {
        pointer('pointerdown', 'touch')
        pointer('pointermove', 'touch', 30)
        vi.advanceTimersByTime(MODULE_GLOBE_HOLD_MS)
        pointer('pointerup', 'touch', 30)
        button.click()
        expect(hold).not.toHaveBeenCalled()
        expect(tap).not.toHaveBeenCalled()
    })

    test('pointer cancellation clears the hold', () => {
        pointer('pointerdown', 'touch')
        pointer('pointercancel', 'touch')
        vi.advanceTimersByTime(MODULE_GLOBE_HOLD_MS)
        button.click()
        expect(hold).not.toHaveBeenCalled()
        expect(tap).not.toHaveBeenCalled()
    })

    test('the globe press does not reach the row or open its context menu', () => {
        const rowPress = vi.fn()
        const rowMenu = vi.fn()
        button.parentElement!.addEventListener('pointerdown', rowPress)
        button.parentElement!.addEventListener('contextmenu', rowMenu)
        pointer('pointerdown', 'mouse')
        vi.advanceTimersByTime(MODULE_GLOBE_HOLD_MS)
        button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
        pointer('pointerup', 'mouse')
        button.click()
        expect(rowPress).not.toHaveBeenCalled()
        expect(rowMenu).not.toHaveBeenCalled()
        expect(hold).toHaveBeenCalledOnce()
        button.parentElement!.removeEventListener('pointerdown', rowPress)
        button.parentElement!.removeEventListener('contextmenu', rowMenu)
    })

    test('without an open bot, holding still acts like a tap', () => {
        destroy()
        destroy = moduleGlobeHold(button, { tap, hold, canHold: () => false }).destroy
        pointer('pointerdown', 'touch')
        vi.advanceTimersByTime(MODULE_GLOBE_HOLD_MS)
        pointer('pointerup', 'touch')
        button.click()
        expect(hold).not.toHaveBeenCalled()
        expect(tap).toHaveBeenCalledOnce()
    })
})
