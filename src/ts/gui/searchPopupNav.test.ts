import { describe, expect, it } from 'vitest'
import { nextSearchIndex, searchEnterIndex } from './searchPopupNav'

describe('chat search popup keyboard navigation', () => {
    it('moves through results and wraps at either end', () => {
        expect(nextSearchIndex(0, 3, 1)).toBe(1)
        expect(nextSearchIndex(2, 3, 1)).toBe(0)
        expect(nextSearchIndex(0, 3, -1)).toBe(2)
        expect(nextSearchIndex(-1, 3, 1)).toBe(0)
        expect(nextSearchIndex(-1, 3, -1)).toBe(2)
    })

    it('uses the highlighted result or the first result for Enter', () => {
        expect(searchEnterIndex(2, 3)).toBe(2)
        expect(searchEnterIndex(-1, 3)).toBe(0)
        expect(searchEnterIndex(5, 3)).toBe(0)
        expect(searchEnterIndex(0, 0)).toBe(-1)
        expect(nextSearchIndex(0, 0, 1)).toBe(-1)
    })
})
