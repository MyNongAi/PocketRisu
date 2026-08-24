export interface VariableVirtualLayout {
    /** Stable, unique item keys in visible catalog order. */
    keys: string[]
    /** Item starts plus one trailing total entry. */
    offsets: number[]
    total: number
}

export interface VariableVirtualRange {
    start: number
    end: number
    offset: number
    total: number
}

export interface VariableScrollAnchor {
    /** The first key is the exact top row; the rest are preceding fallbacks. */
    candidates: string[]
    offsetWithinItem: number
}

function safeExtent(value: number, fallback: number) {
    return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Build a prefix-sum layout while preserving measurements by stable key.
 * Unknown/offscreen rows use the estimate until ResizeObserver sees them.
 */
export function buildVariableVirtualLayout(
    keys: ReadonlyArray<string>,
    measurements: ReadonlyMap<string, number>,
    estimatedItemHeight: number,
): VariableVirtualLayout {
    const estimate = safeExtent(estimatedItemHeight, 1)
    const offsets = new Array<number>(keys.length + 1)
    offsets[0] = 0

    for(let index = 0; index < keys.length; index++){
        const measured = measurements.get(keys[index]) ?? estimate
        offsets[index + 1] = offsets[index] + safeExtent(measured, estimate)
    }

    return {
        keys: Array.from(keys),
        offsets,
        total: offsets[offsets.length - 1] ?? 0,
    }
}

/** Find the row intersecting an offset in O(log N). */
export function variableItemIndexAtOffset(layout: VariableVirtualLayout, offset: number) {
    const count = layout.keys.length
    if(count === 0) return -1

    const target = Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, Math.max(0, layout.total - 1)))
    let low = 0
    let high = count
    while(low < high){
        const middle = Math.floor((low + high) / 2)
        if(layout.offsets[middle + 1] <= target) low = middle + 1
        else high = middle
    }
    return Math.min(low, count - 1)
}

/** Return only viewport rows plus a bounded pixel overscan. */
export function variableVirtualWindow(
    layout: VariableVirtualLayout,
    scrollOffset: number,
    viewportExtent: number,
    overscanExtent = 0,
): VariableVirtualRange {
    const count = layout.keys.length
    if(count === 0) return { start: 0, end: 0, offset: 0, total: 0 }

    const scroll = Math.max(0, Number.isFinite(scrollOffset) ? scrollOffset : 0)
    const viewport = Math.max(0, Number.isFinite(viewportExtent) ? viewportExtent : 0)
    const overscan = Math.max(0, Number.isFinite(overscanExtent) ? overscanExtent : 0)
    const rangeStart = Math.max(0, scroll - overscan)
    const rangeEnd = Math.min(layout.total, scroll + viewport + overscan)
    const start = variableItemIndexAtOffset(layout, rangeStart)

    // Find the first row start at or beyond rangeEnd. Keeping `end` exclusive
    // avoids mounting the next row when the boundary lands exactly on it.
    let low = start + 1
    let high = count
    while(low < high){
        const middle = Math.floor((low + high) / 2)
        if(layout.offsets[middle] < rangeEnd) low = middle + 1
        else high = middle
    }
    const end = Math.max(start + 1, Math.min(count, low))

    return {
        start,
        end,
        offset: layout.offsets[start],
        total: layout.total,
    }
}

/**
 * Capture the top row and a few preceding rows. The fallbacks keep a nearby
 * folder header anchored when collapse/search removes the exact top row.
 */
export function captureVariableScrollAnchor(
    layout: VariableVirtualLayout,
    scrollOffset: number,
    fallbackCount = 24,
): VariableScrollAnchor | null {
    const index = variableItemIndexAtOffset(layout, scrollOffset)
    if(index < 0) return null

    const candidates: string[] = []
    for(let cursor = index; cursor >= 0 && candidates.length <= Math.max(0, fallbackCount); cursor--){
        candidates.push(layout.keys[cursor])
    }

    return {
        candidates,
        offsetWithinItem: Math.max(0, scrollOffset - layout.offsets[index]),
    }
}

export function clampVariableScroll(
    layout: VariableVirtualLayout,
    scrollOffset: number,
    viewportExtent: number,
) {
    const maxScroll = Math.max(0, layout.total - Math.max(0, viewportExtent))
    return Math.max(0, Math.min(Number.isFinite(scrollOffset) ? scrollOffset : 0, maxScroll))
}

/** Restore an anchor after measurement, reorder, search, or folder collapse. */
export function restoreVariableScrollAnchor(
    anchor: VariableScrollAnchor | null,
    layout: VariableVirtualLayout,
    viewportExtent: number,
    fallbackScroll = 0,
) {
    if(anchor){
        const indexByKey = new Map(layout.keys.map((key, index) => [key, index]))
        for(let candidateIndex = 0; candidateIndex < anchor.candidates.length; candidateIndex++){
            const itemIndex = indexByKey.get(anchor.candidates[candidateIndex])
            if(itemIndex === undefined) continue
            const itemHeight = layout.offsets[itemIndex + 1] - layout.offsets[itemIndex]
            const itemOffset = candidateIndex === 0
                ? Math.min(anchor.offsetWithinItem, Math.max(0, itemHeight - 1))
                : 0
            return clampVariableScroll(layout, layout.offsets[itemIndex] + itemOffset, viewportExtent)
        }
    }
    return clampVariableScroll(layout, fallbackScroll, viewportExtent)
}
