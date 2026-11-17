import { describe, expect, it } from 'vitest'
import { TAP_MAX_MS, TAP_SLOP_PX, isStrayTouch, touchPressMove, touchPressStart } from './touchTap'

const touch = (x: number, y: number, timeStamp: number) => ({ pointerType: 'touch', clientX: x, clientY: y, timeStamp })

describe('a list opens only on a touch tap (2026-11-18)', () => {
    it('takes a short, still touch as a tap', () => {
        touchPressStart(touch(100, 100, 1000))
        touchPressMove(touch(103, 104, 1050))
        expect(isStrayTouch({ pointerType: 'touch', timeStamp: 1000 + TAP_MAX_MS })).toBe(false)
    })

    it('does not take a stroke as a tap, even a quick one', () => {
        touchPressStart(touch(100, 100, 1000))
        touchPressMove(touch(100, 100 + TAP_SLOP_PX + 1, 1040))
        // Back where it started: it still stroked.
        touchPressMove(touch(100, 100, 1080))
        expect(isStrayTouch({ pointerType: 'touch', timeStamp: 1100 })).toBe(true)
    })

    it('does not take a finger that stayed as a tap', () => {
        touchPressStart(touch(100, 100, 1000))
        expect(isStrayTouch({ pointerType: 'touch', timeStamp: 1000 + TAP_MAX_MS + 1 })).toBe(true)
    })

    it('leaves a mouse and a keyboard alone', () => {
        touchPressStart(touch(100, 100, 1000))
        touchPressMove(touch(200, 200, 1010))
        expect(isStrayTouch({ pointerType: 'mouse', timeStamp: 5000 })).toBe(false)
        expect(isStrayTouch({ pointerType: '', timeStamp: 5000 })).toBe(false)
        // A mouse press clears the touch it follows.
        touchPressStart({ pointerType: 'mouse', clientX: 0, clientY: 0, timeStamp: 6000 })
        expect(isStrayTouch({ pointerType: 'touch', timeStamp: 9000 })).toBe(false)
    })
})
