// Heights a text field was dragged to with its corner (ResizeCorner.svelte).
// A field with a storage key keeps its height on this device.

const STORAGE_PREFIX = 'pocketrisu:textarea-height:'
const MIN_STORED_HEIGHT = 80

export function readStoredFieldHeight(key: string | undefined): number | null {
    if (!key) return null
    try {
        const value = Number(localStorage.getItem(STORAGE_PREFIX + key))
        return Number.isFinite(value) && value >= MIN_STORED_HEIGHT ? value : null
    } catch {
        return null
    }
}

export function storeFieldHeight(key: string | undefined, height: number | null): void {
    if (!key) return
    try {
        if (height) localStorage.setItem(STORAGE_PREFIX + key, String(height))
        else localStorage.removeItem(STORAGE_PREFIX + key)
    } catch {
        // remembered for this page only
    }
}

/**
 * The height a drag of `delta` pixels gives a field that started at
 * `startHeight`; null (the default height) at or below `minHeight`, the
 * field's own minimum.
 */
export function draggedFieldHeight(startHeight: number, delta: number, minHeight: number): number | null {
    const next = Math.round(startHeight + delta)
    return next <= minHeight ? null : next
}
