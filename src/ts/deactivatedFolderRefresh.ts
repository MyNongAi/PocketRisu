import { checkCharOrder } from './globalApi.svelte'

/**
 * Deactivated characters drift into older idle-age folders as days pass
 * without anything touching the order. checkCharOrder already runs at boot
 * and on every list change; this hourly run covers a page left open. It
 * writes (and therefore saves) only when a character actually changed bucket.
 */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000

let refreshTimer: ReturnType<typeof setInterval> | null = null

export function scheduleDeactivatedFolderRefresh(): void {
    if (refreshTimer !== null) return
    refreshTimer = setInterval(() => {
        try {
            checkCharOrder()
        } catch (error) {
            console.warn('[DeactivatedFolders] hourly refresh skipped:', error)
        }
    }, REFRESH_INTERVAL_MS)
}
