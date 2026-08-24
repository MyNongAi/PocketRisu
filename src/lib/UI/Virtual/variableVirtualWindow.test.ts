import { describe, expect, it } from 'vitest'
import {
    buildVariableVirtualLayout,
    captureVariableScrollAnchor,
    restoreVariableScrollAnchor,
    variableItemIndexAtOffset,
    variableVirtualWindow,
} from './variableVirtualWindow'

describe('variable-height virtual window math', () => {
    it('uses measured heights and mounts only viewport plus overscan', () => {
        const layout = buildVariableVirtualLayout(
            ['a', 'b', 'c', 'd', 'e'],
            new Map([['a', 40], ['b', 120], ['c', 60], ['d', 80], ['e', 100]]),
            70,
        )

        expect(layout.offsets).toEqual([0, 40, 160, 220, 300, 400])
        expect(variableItemIndexAtOffset(layout, 159)).toBe(1)
        expect(variableItemIndexAtOffset(layout, 160)).toBe(2)
        expect(variableVirtualWindow(layout, 170, 100, 20)).toEqual({
            start: 1,
            end: 4,
            offset: 40,
            total: 400,
        })
    })

    it('keeps the same top row stable as heights above it are measured', () => {
        const keys = ['folder', 'a', 'b', 'c']
        const estimated = buildVariableVirtualLayout(keys, new Map(), 100)
        const anchor = captureVariableScrollAnchor(estimated, 215)
        const measured = buildVariableVirtualLayout(
            keys,
            new Map([['folder', 52], ['a', 180], ['b', 90], ['c', 110]]),
            100,
        )

        // `b` remains 15px below the viewport top despite rows above changing.
        expect(anchor?.candidates[0]).toBe('b')
        expect(restoreVariableScrollAnchor(anchor, measured, 80)).toBe(247)
    })

    it('anchors a surviving preceding folder header when collapse removes children', () => {
        const before = buildVariableVirtualLayout(
            ['folder:x', 'module:a', 'module:b', 'module:c', 'root:z'],
            new Map(),
            80,
        )
        const anchor = captureVariableScrollAnchor(before, 190)
        const after = buildVariableVirtualLayout(
            ['folder:x', 'root:z'],
            new Map([['folder:x', 48], ['root:z', 80]]),
            80,
        )

        expect(anchor?.candidates.slice(0, 3)).toEqual(['module:b', 'module:a', 'folder:x'])
        expect(restoreVariableScrollAnchor(anchor, after, 64)).toBe(0)
    })

    it('keeps the anchor inside a row when its open controls collapse', () => {
        const before = buildVariableVirtualLayout(['a', 'picker', 'c'], new Map([['a', 50], ['picker', 200], ['c', 80]]), 80)
        const anchor = captureVariableScrollAnchor(before, 190)
        const after = buildVariableVirtualLayout(['a', 'picker', 'c'], new Map([['a', 50], ['picker', 80], ['c', 80]]), 80)

        // The old 140px inner offset no longer exists; clamp to the final pixel
        // of the same row instead of silently jumping into a following row.
        expect(restoreVariableScrollAnchor(anchor, after, 20)).toBe(129)
    })

    it('preserves an item across recent-order changes and resets safely if no anchor survives', () => {
        const before = buildVariableVirtualLayout(['a', 'b', 'c', 'd'], new Map(), 50)
        const anchor = captureVariableScrollAnchor(before, 105)
        const reordered = buildVariableVirtualLayout(['d', 'c', 'b', 'a'], new Map(), 50)
        const unrelatedSearch = buildVariableVirtualLayout(['search:1', 'search:2'], new Map(), 50)

        expect(restoreVariableScrollAnchor(anchor, reordered, 50)).toBe(55)
        expect(restoreVariableScrollAnchor(anchor, unrelatedSearch, 50)).toBe(0)
    })
})
