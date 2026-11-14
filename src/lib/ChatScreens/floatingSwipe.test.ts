import { describe, expect, it } from 'vitest'
import { floatingSwipeBottom, floatingSwipeShows, floatingSwipeVisible } from './floatingSwipe'

// A view from 100 to 900; the reply's rows are 36px tall.
const view = { top: 100, bottom: 900 }
const row = (top: number) => ({ top, bottom: top + 36 })

describe('floating swipe activity', () => {
    it('shows only during scrolling, hover, or a press while the reply row is away', () => {
        expect(floatingSwipeVisible(true, true, false, false)).toBe(true)
        expect(floatingSwipeVisible(true, false, false, false)).toBe(false)
        expect(floatingSwipeVisible(true, false, true, false)).toBe(true)
        expect(floatingSwipeVisible(true, false, false, true)).toBe(true)
        expect(floatingSwipeVisible(false, true, true, true)).toBe(false)
    })
})

describe('floating ‹ page › ↻ of the newest reply', () => {
    it('shows once the reply\'s row is above the view, while the reply is still being read', () => {
        expect(floatingSwipeShows([row(40)], { top: 40, bottom: 2000 }, view)).toBe(true)
        expect(floatingSwipeShows([row(64)], { top: 64, bottom: 2000 }, view)).toBe(true)
        // The row still on screen: it is pressed there.
        expect(floatingSwipeShows([row(80)], { top: 80, bottom: 2000 }, view)).toBe(false)
        // Only the reply's last few pixels left at the top: nothing to read.
        expect(floatingSwipeShows([row(-900)], { top: -900, bottom: 130 }, view)).toBe(false)
        expect(floatingSwipeShows([row(-900)], { top: -900, bottom: 148 }, view)).toBe(true)
        // No row at all (a reply that is not the reroll target).
        expect(floatingSwipeShows([], { top: -900, bottom: 2000 }, view)).toBe(false)
    })

    it('hides while the row at the reply\'s end is on screen, and counts one under the composer as off it', () => {
        expect(floatingSwipeShows([row(-900), row(700)], { top: -900, bottom: 760 }, view)).toBe(false)
        // The end row behind the composer (the view stops at 880).
        expect(floatingSwipeShows([row(-900), row(870)], { top: -900, bottom: 930 }, { top: 100, bottom: 860 })).toBe(true)
    })

    it('sits above the scroll buttons when they are at the bottom, and above the composer where it shows', () => {
        expect(floatingSwipeBottom('two', 'right-center')).toBe(64)
        expect(floatingSwipeBottom('two', undefined)).toBe(64)
        expect(floatingSwipeBottom('two', 'right-bottom')).toBe(144)
        expect(floatingSwipeBottom('two', 'bottom-center')).toBe(108)
        expect(floatingSwipeBottom('off', 'right-bottom')).toBe(64)
        expect(floatingSwipeBottom('two', 'right-center', 120)).toBe(128)
        expect(floatingSwipeBottom('two', 'right-center', 30)).toBe(64)
    })
})
