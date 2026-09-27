import { checkCharOrder } from './globalApi.svelte'

/**
 * Deactivated characters drift into older idle-age folders as days pass
 * without anything touching the order. checkCharOrder already runs at boot
 * and on every list change; this hourly run covers a page left open. It
 * writes (and therefore saves) only when a character actually changed bucket.
 *
 * A hidden tab skips the run. Its background write would race whatever the
 * user is doing on another device, and a 409 rebase keeps the local order, so
 * an unattended re-bucket could undo a folder edit made elsewhere. The device
 * in use re-buckets on its own (boot, list changes, this timer while visible).
 */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000

let refreshTimer: ReturnType<typeof setInterval> | null = null

export function scheduleDeactivatedFolderRefresh(): void {
    if (refreshTimer !== null) return
    refreshTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        try {
            checkCharOrder()
        } catch (error) {
            console.warn('[DeactivatedFolders] hourly refresh skipped:', error)
        }
    }, REFRESH_INTERVAL_MS)
}
