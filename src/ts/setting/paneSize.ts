export const SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY = 'pocketrisu-settings-sidebar-width-v1'
export const DEFAULT_SETTINGS_SIDEBAR_WIDTH = 224
export const MIN_SETTINGS_SIDEBAR_WIDTH = 168
export const MAX_SETTINGS_SIDEBAR_WIDTH = 400
export const MIN_SETTINGS_CONTENT_WIDTH = 360

type SettingsPaneStorage = Pick<Storage, 'getItem' | 'setItem'>

/** Keep the navigation usable without squeezing the active settings page away. */
export function clampSettingsSidebarWidth(width: number, containerWidth: number): number {
    const finiteWidth = Number.isFinite(width) ? width : DEFAULT_SETTINGS_SIDEBAR_WIDTH
    const finiteContainer = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0
    const availableMaximum = Math.max(
        MIN_SETTINGS_SIDEBAR_WIDTH,
        finiteContainer - MIN_SETTINGS_CONTENT_WIDTH,
    )
    const maximum = Math.min(MAX_SETTINGS_SIDEBAR_WIDTH, availableMaximum)
    return Math.round(Math.min(maximum, Math.max(MIN_SETTINGS_SIDEBAR_WIDTH, finiteWidth)))
}

export function readSettingsSidebarWidth(storage?: SettingsPaneStorage | null): number {
    if (!storage) return DEFAULT_SETTINGS_SIDEBAR_WIDTH
    try {
        const value = Number(storage.getItem(SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY))
        return Number.isFinite(value) && value > 0 ? value : DEFAULT_SETTINGS_SIDEBAR_WIDTH
    } catch {
        return DEFAULT_SETTINGS_SIDEBAR_WIDTH
    }
}

export function writeSettingsSidebarWidth(width: number, storage?: SettingsPaneStorage | null): void {
    if (!storage || !Number.isFinite(width)) return
    try {
        storage.setItem(SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)))
    } catch {
        // Denied/full localStorage must never make the settings view unusable.
    }
}
