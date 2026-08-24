export function virtualWindow(
    itemCount: number,
    itemExtent: number,
    scrollOffset: number,
    viewportExtent: number,
    overscan = 3,
) {
    const count = Math.max(0, Math.floor(itemCount))
    const extent = Math.max(1, itemExtent)
    const safeOverscan = Math.max(0, Math.floor(overscan))
    const firstVisible = Math.floor(Math.max(0, scrollOffset) / extent)
    const visibleCount = Math.ceil(Math.max(0, viewportExtent) / extent)
    const start = Math.max(0, firstVisible - safeOverscan)
    const end = Math.min(count, firstVisible + visibleCount + safeOverscan)
    return { start, end, offset: start * extent, total: count * extent }
}

export function virtualGridLayout(
    width: number,
    minItemWidth: number,
    gap: number,
    aspectRatio = 1,
) {
    const safeWidth = Math.max(1, width)
    const safeGap = Math.max(0, gap)
    const minWidth = Math.max(1, minItemWidth)
    const columns = Math.max(1, Math.floor((safeWidth + safeGap) / (minWidth + safeGap)))
    const itemWidth = (safeWidth - safeGap * (columns - 1)) / columns
    const itemHeight = itemWidth / Math.max(0.01, aspectRatio)
    return { columns, itemWidth, itemHeight, rowExtent: itemHeight + safeGap }
}
