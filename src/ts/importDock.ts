// The folded import/export cards' button (ImportProgressToaster folds them),
// drawn in the same column as the folded request buttons (RequestStatusDock):
// it had its own spot at the top right, where it covered the request cards
// and buttons (the user's report, 2026-10-17).
import { derived, writable } from 'svelte/store'
import { minimizedRequests } from './status/requestStatusDock'

export interface ImportDockPill {
    /** Folded tasks still running (or failed while folded). */
    count: number
    /** Their mean progress, when any reports one. */
    progress: number | null
    failed: boolean
}

export const importDockPill = writable<ImportDockPill>({ count: 0, progress: null, failed: false })

let restore: () => void = () => {}

/** ImportProgressToaster: what the button does (show the folded cards again). */
export function setImportDockRestore(action: () => void): void {
    restore = action
}

export function restoreImportDock(): void {
    restore()
}

/** Whether the dock column shows (the toasts move left of it on a PC). */
export const dockVisible = derived([minimizedRequests, importDockPill], ([requests, pill]) => requests.length > 0 || pill.count > 0)
