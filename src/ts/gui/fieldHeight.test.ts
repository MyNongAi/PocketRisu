import { afterEach, describe, expect, it } from 'vitest'
import { draggedFieldHeight, readStoredFieldHeight, storeFieldHeight } from './fieldHeight'

describe('draggedFieldHeight', () => {
    it('follows the drag and rounds to whole pixels', () => {
        expect(draggedFieldHeight(160, 40.4, 160)).toBe(200)
    })

    it('goes back to the default at or below the minimum', () => {
        expect(draggedFieldHeight(200, -40, 160)).toBeNull()
        expect(draggedFieldHeight(200, -80, 160)).toBeNull()
        expect(draggedFieldHeight(200, -39, 160)).toBe(161)
    })
})

describe('stored field heights', () => {
    afterEach(() => localStorage.clear())

    it('keeps a height under its key and drops it on reset', () => {
        storeFieldHeight('lorebook', 320)
        expect(readStoredFieldHeight('lorebook')).toBe(320)
        expect(localStorage.getItem('pocketrisu:textarea-height:lorebook')).toBe('320')
        storeFieldHeight('lorebook', null)
        expect(readStoredFieldHeight('lorebook')).toBeNull()
    })

    it('stores nothing without a key and ignores a broken value', () => {
        storeFieldHeight(undefined, 320)
        expect(localStorage.length).toBe(0)
        expect(readStoredFieldHeight(undefined)).toBeNull()
        localStorage.setItem('pocketrisu:textarea-height:x', 'tall')
        expect(readStoredFieldHeight('x')).toBeNull()
        localStorage.setItem('pocketrisu:textarea-height:x', '20')
        expect(readStoredFieldHeight('x')).toBeNull()
    })
})
