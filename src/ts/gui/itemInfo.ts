// One info dialog for a bot, a module or a module folder (the user's request,
// 2026-11-07: "링크, 느낌표, 색 그런거 설정할수있는 팝업창으로 진입할수있는
// 정보창 버튼", like the settings dialog a bot folder opens on right-click).
// It holds the title color (as swatches, white included), the missing-asset
// mark (❗ / red title), which the user can turn off, and the red chain of a
// pairing whose other side is gone, which the user can clear.

import { writable } from 'svelte/store'

export type ItemInfoKind = 'character' | 'module' | 'moduleFolder'

export interface ItemInfoTarget {
    kind: ItemInfoKind
    id: string
}

/** The open dialog's target (ItemInfoDialog in App.svelte); null when closed. */
export const itemInfoTarget = writable<ItemInfoTarget | null>(null)

export function openItemInfo(kind: ItemInfoKind, id: string): void {
    if (id) itemInfoTarget.set({ kind, id })
}

/**
 * Turn the list's missing-asset mark off at the current count (it shows again
 * once more assets are missing), or back on.
 */
export function setMissingMarkHidden(
    owner: { sourceInfo?: { missingAssetCount?: number, nodeOnlyMissingMarkHidden?: number } } | null | undefined,
    hidden: boolean,
): void {
    const info = owner?.sourceInfo
    if (!info) return
    if (hidden) info.nodeOnlyMissingMarkHidden = Math.max(1, Number(info.missingAssetCount) || 0)
    else delete info.nodeOnlyMissingMarkHidden
}

/** A bot's own modules without the ones that no longer exist (its red chain). */
export function withoutMissingModules(modules: readonly string[] | undefined, existingModuleIds: ReadonlySet<string>): string[] {
    return (modules ?? []).filter((id) => existingModuleIds.has(id))
}
