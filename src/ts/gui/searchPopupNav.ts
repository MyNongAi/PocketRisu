// Keyboard navigation for the chat search popup.
export function nextSearchIndex(current: number, count: number, direction: -1 | 1): number {
    if (count <= 0) return -1
    if (current < 0 || current >= count) return direction === 1 ? 0 : count - 1
    return (current + direction + count) % count
}

export function searchEnterIndex(current: number, count: number): number {
    if (count <= 0) return -1
    return current >= 0 && current < count ? current : 0
}
