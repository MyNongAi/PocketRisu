// Why this page life started, sent once with the session boot (nodeStorage)
// so the server log tells apart a browser that dropped the tab while it was
// in the background, the app reloading itself into a new build
// (storage/buildFence.ts), and a reload or fresh open by the user (the
// user's report, 2026-10-13: on the phone the app opened anew after a short
// time in the background).

import { startedByBuildReload } from './storage/buildFence'

const HIDDEN_AT_KEY = 'pocketrisu-hidden-at'

// Seconds the previous page life had been in the background when this one
// started, read before the listener below clears the mark.
let hiddenForSeconds: number | null = null

if (typeof document !== 'undefined') {
    try {
        const hiddenAt = Number(sessionStorage.getItem(HIDDEN_AT_KEY))
        if (hiddenAt > 0) hiddenForSeconds = Math.max(0, Math.round((Date.now() - hiddenAt) / 1000))
        sessionStorage.removeItem(HIDDEN_AT_KEY)
    } catch {
        // No session storage: the reason goes without the hidden time.
    }
    document.addEventListener('visibilitychange', () => {
        try {
            if (document.visibilityState === 'hidden') sessionStorage.setItem(HIDDEN_AT_KEY, String(Date.now()))
            else sessionStorage.removeItem(HIDDEN_AT_KEY)
        } catch {
            // best-effort
        }
    })
}

/** e.g. "nav=reload discarded hidden=95s app"; empty outside a browser. */
export function bootReason(): string {
    if (typeof document === 'undefined') return ''
    const parts: string[] = []
    try {
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
        if (navigation?.type) parts.push(`nav=${navigation.type}`)
    } catch {
        // older browsers
    }
    // Chromium: the tab was discarded in the background and reloaded on return.
    if ((document as Document & { wasDiscarded?: boolean }).wasDiscarded) parts.push('discarded')
    if (startedByBuildReload()) parts.push('build-reload')
    if (hiddenForSeconds !== null) parts.push(`hidden=${hiddenForSeconds}s`)
    try {
        if (matchMedia('(display-mode: standalone)').matches) parts.push('app')
    } catch {
        // no matchMedia
    }
    return parts.join(' ')
}
