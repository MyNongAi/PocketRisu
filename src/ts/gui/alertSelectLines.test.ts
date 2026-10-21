import { describe, expect, it } from 'vitest'
import { alertSelectLines } from './alertSelectLines'

describe('alertSelectLines', () => {
    it('puts neighbours of one row on a line and leaves the rest alone', () => {
        const actions = [{ label: 'a', row: 'x' }, { label: 'b', row: 'x' }, { label: 'c' }, { label: 'd', row: 'y' }, { label: 'e', row: 'x' }]
        expect(alertSelectLines(6, actions)).toEqual([[0, 1], [2], [3], [4], [5]])
        expect(alertSelectLines(3, undefined)).toEqual([[0], [1], [2]])
    })
})
