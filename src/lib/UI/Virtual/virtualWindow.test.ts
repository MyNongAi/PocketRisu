import { describe, expect, it } from 'vitest'
import { virtualGridLayout, virtualWindow } from './virtualWindow'

describe('virtual window math', () => {
    it('mounts only the visible rows plus bounded overscan', () => {
        expect(virtualWindow(100_000, 100, 50_000, 500, 2)).toEqual({
            start: 498,
            end: 507,
            offset: 49_800,
            total: 10_000_000,
        })
    })

    it('computes a responsive fixed-row grid', () => {
        expect(virtualGridLayout(636, 140, 12, 1)).toEqual({
            columns: 4,
            itemWidth: 150,
            itemHeight: 150,
            rowExtent: 162,
        })
    })
})
