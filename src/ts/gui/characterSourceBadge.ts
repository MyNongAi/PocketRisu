export type CharacterSourceBadge = '로컬' | '웹' | '모바일' | '포켓'

export interface ResolvedCharacterSource {
    label: CharacterSourceBadge
    /** False for legacy characters that predate sourceInfo tracking. */
    recorded: boolean
}

/**
 * Collapse verbose collection labels into the origins used by the UI.
 *
 * The current PocketRisu collection was seeded from the PC web collection, so
 * old entries without sourceInfo use 웹 as an explicit baseline fallback. New
 * source-collection imports carry their own label and never hit that fallback.
 *
 * `localStamp` is when this install itself brought the item in (a bot's
 * importedAt, a persona's createdAt, a module's importedAt): only PocketRisu
 * writes those, so an item without a source label but with a stamp was
 * downloaded or made here after the move from the web collection, and shows
 * 포켓 instead of the 웹 guess (the user's request, 2026-10-05).
 */
export function resolveCharacterSourceBadge(value: unknown, localStamp?: number): ResolvedCharacterSource {
    const raw = typeof value === 'string' ? value.trim() : ''
    const normalized = raw.toLocaleLowerCase().replace(/\s+/g, '')
    if (normalized.includes('포켓') || normalized.includes('pocket')) {
        return { label: '포켓', recorded: true }
    }
    if (normalized.includes('모바일') || normalized.includes('mobile')) {
        return { label: '모바일', recorded: true }
    }
    if (normalized.includes('로컬') || normalized.includes('local')) {
        return { label: '로컬', recorded: true }
    }
    if (normalized.includes('웹') || normalized.includes('web')) {
        return { label: '웹', recorded: true }
    }
    if (typeof localStamp === 'number' && localStamp > 0) {
        return { label: '포켓', recorded: true }
    }
    return { label: '웹', recorded: false }
}
