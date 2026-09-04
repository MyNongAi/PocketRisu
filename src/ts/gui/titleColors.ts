/** Small display-only metadata; never accept arbitrary CSS from imported cards. */
export function normalizeTitleColor(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const color = value.trim()
    return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : undefined
}

export function listTitleColor(value: unknown, missing = false): string | undefined {
    // Missing assets remain visually urgent; the adjacent badge separately
    // communicates whether a conclusive Realm recovery source is known.
    return normalizeTitleColor(value) ?? (missing ? '#f87171' : undefined)
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
    { label: '빨강', value: '#f87171' },
    { label: '주황', value: '#fb923c' },
    { label: '노랑', value: '#facc15' },
    { label: '초록', value: '#4ade80' },
    { label: '하늘', value: '#38bdf8' },
    { label: '파랑', value: '#818cf8' },
    { label: '보라', value: '#c084fc' },
    { label: '분홍', value: '#f472b6' },
] as const

/** null = cancel; empty string = reset to the theme's default. */
export async function chooseTitleColor(current?: string): Promise<string | null> {
    const { alertInput, alertSelect } = await import('../alert')
    const selection = await alertSelect(
        [...TITLE_COLOR_OPTIONS.map(option => option.label), '직접 입력 (#RRGGBB)', '취소'],
        `제목 색상 · 현재 ${normalizeTitleColor(current) || '기본 색상'}`,
    )
    if (!/^\d+$/.test(selection)) return null
    const index = Number(selection)
    if (index < TITLE_COLOR_OPTIONS.length) return TITLE_COLOR_OPTIONS[index].value
    if (index !== TITLE_COLOR_OPTIONS.length) return null
    const value = await alertInput('제목 색상 (#RRGGBB)', [], normalizeTitleColor(current) || '#38bdf8')
    return normalizeTitleColor(value) ?? null
}
