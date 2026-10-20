import { describe, expect, it } from 'vitest'
import { buttonRows, rowAt, rowFromBottom } from './swipeAnchor'

describe('the pressed swipe row, found again in the redrawn message', () => {
    it('groups buttons into rows and counts them from the bottom', () => {
        // top row (← 1/3 → ↻ at 43-45), bottom row at 2463
        const rows = buttonRows([2463, 45, 43, 44, 2464])
        expect(rows).toEqual([43, 2463])
        expect(rowFromBottom(rows, 2464)).toBe(0)
        expect(rowFromBottom(rows, 44)).toBe(1)
    })

    it('finds the same row in a swipe of another length', () => {
        const before = buttonRows([43, 2463])
        const pressed = rowFromBottom(before, 2463)
        // a longer swipe: the bottom row is further down
        expect(rowAt(buttonRows([43, 4912]), pressed)).toBe(4912)
        expect(rowAt(buttonRows([43, 4912]), rowFromBottom(before, 43))).toBe(43)
        // a row that is gone
        expect(rowAt([], 0)).toBeNull()
        expect(rowAt([10], 1)).toBeNull()
    })
})
