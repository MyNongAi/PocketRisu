export const SETTINGS_MENU_ORDER_STORAGE_KEY = 'pocketrisu-settings-menu-order-v1'

type SettingsMenuStorage = Pick<Storage, 'getItem' | 'setItem'>

function uniqueStrings(values: readonly string[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []

    for (const value of values) {
        if (typeof value !== 'string' || seen.has(value)) continue
        seen.add(value)
        result.push(value)
    }

    return result
}

/**
 * Keeps valid saved ids in their user-defined order and appends newly added
 * settings pages in the application's default order.
 */
export function normalizeSettingsMenuOrder(saved: unknown, defaultIds: readonly string[]): string[] {
    const defaults = uniqueStrings(defaultIds)
    if (!Array.isArray(saved)) return defaults

    const allowed = new Set(defaults)
    const ordered = uniqueStrings(saved.filter((id): id is string => typeof id === 'string'))
        .filter((id) => allowed.has(id))
    const present = new Set(ordered)

    return [...ordered, ...defaults.filter((id) => !present.has(id))]
}

/**
 * Lite mode can temporarily hide some menu entries. Reordering only the
 * visible rows must not erase or unexpectedly move those hidden entries.
 */
export function mergeVisibleSettingsMenuOrder(
    currentOrder: readonly string[],
    visibleOrder: readonly string[],
): string[] {
    const visibleSet = new Set(visibleOrder)
    const currentVisible = currentOrder.filter((id) => visibleSet.has(id))
    const normalizedVisible = normalizeSettingsMenuOrder(visibleOrder, currentVisible)
    let visibleIndex = 0

    return currentOrder.map((id) => {
        if (!visibleSet.has(id)) return id
        return normalizedVisible[visibleIndex++] ?? id
    })
}

/** Move one visible item while preserving every hidden item's stored slot. */
export function moveVisibleSettingsMenuItem(
    currentOrder: readonly string[],
    visibleOrder: readonly string[],
    itemId: string,
    offset: -1 | 1,
): string[] {
    const currentIndex = visibleOrder.indexOf(itemId)
    const targetIndex = currentIndex + offset
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= visibleOrder.length) {
        return [...currentOrder]
    }

    const reorderedVisible = [...visibleOrder]
    const [moved] = reorderedVisible.splice(currentIndex, 1)
    reorderedVisible.splice(targetIndex, 0, moved)
    return mergeVisibleSettingsMenuOrder(currentOrder, reorderedVisible)
}

export function readSettingsMenuOrder(
    defaultIds: readonly string[],
    storage?: SettingsMenuStorage | null,
): string[] {
    if (!storage) return normalizeSettingsMenuOrder(undefined, defaultIds)

    try {
        const raw = storage.getItem(SETTINGS_MENU_ORDER_STORAGE_KEY)
        return normalizeSettingsMenuOrder(raw ? JSON.parse(raw) : undefined, defaultIds)
    } catch {
        return normalizeSettingsMenuOrder(undefined, defaultIds)
    }
}

export function writeSettingsMenuOrder(order: readonly string[], storage?: SettingsMenuStorage | null): void {
    if (!storage) return

    try {
        storage.setItem(SETTINGS_MENU_ORDER_STORAGE_KEY, JSON.stringify(uniqueStrings(order)))
    } catch {
        // A denied or full localStorage must never make Settings unusable.
    }
}
