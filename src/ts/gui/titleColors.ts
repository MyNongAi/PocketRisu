/** Small display-only metadata; never accept arbitrary CSS from imported cards. */
export function normalizeTitleColor(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const color = value.trim()
    return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : undefined
}

/**
 * The missing-asset count a list shows (❗, the red title, the corner count).
 * 0 while the user turned the mark off at that count or more in the info
 * dialog (ItemInfoDialog, the user's request 2026-11-07); more missing brings
 * it back. Tools that manage assets read sourceInfo.missingAssetCount itself.
 */
export function shownMissingAssetCount(sourceInfo: { missingAssetCount?: unknown, nodeOnlyMissingMarkHidden?: unknown } | null | undefined): number {
    const missing = Math.max(0, Number(sourceInfo?.missingAssetCount) || 0)
    const hiddenAt = Number(sourceInfo?.nodeOnlyMissingMarkHidden)
    return Number.isFinite(hiddenAt) && hiddenAt > 0 && missing <= hiddenAt ? 0 : missing
}

export function listTitleColor(value: unknown, missing = false): string | undefined {
    // Missing assets remain visually urgent; the adjacent badge separately
    // communicates whether a conclusive Realm recovery source is known.
    return normalizeTitleColor(value) ?? (missing ? '#f87171' : undefined)
}

/** PocketRisu: the title shows red, by its own colour or by missing assets
 *  without one (the trash's "red titles only" empty, 2026-10-23). */
export function isRedListTitle(value: unknown, missing = false): boolean {
    return listTitleColor(value, missing) === '#f87171'
}

/** True only for an explicit Realm id or a conclusive plugin lookup. */
export function isRealmAssetRecoveryAvailable(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false
    const owner = value as {
        realmId?: unknown
        extentions?: { risuRealmImportId?: unknown }
        extensions?: { risuRealmImportId?: unknown }
        sourceInfo?: { realmAssetRecoveryAvailable?: unknown }
    }
    const directId = owner.realmId
        ?? owner.extentions?.risuRealmImportId
        ?? owner.extensions?.risuRealmImportId
    return (typeof directId === 'string' && directId.trim().length > 0)
        || owner.sourceInfo?.realmAssetRecoveryAvailable === true
}

export const TITLE_COLOR_OPTIONS = [
    { label: '기본 색상', value: '' },
    // The user's request, 2026-11-07: "흰색은 없는건가".
    { label: '흰색', value: '#ffffff' },
    { label: '빨강', value: '#f87171' },
    { label: '주황', value: '#fb923c' },
    { label: '노랑', value: '#facc15' },
    { label: '초록', value: '#4ade80' },
    { label: '하늘', value: '#38bdf8' },
    { label: '파랑', value: '#818cf8' },
    { label: '보라', value: '#c084fc' },
    { label: '분홍', value: '#f472b6' },
] as const
