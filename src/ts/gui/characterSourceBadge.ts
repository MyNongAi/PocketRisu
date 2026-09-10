export type CharacterSourceBadge = '로컬' | '웹' | '모바일'

export interface ResolvedCharacterSource {
    label: CharacterSourceBadge
    /** False for legacy characters that predate sourceInfo tracking. */
    recorded: boolean
}

/**
 * Collapse verbose collection labels into the three origins used by the UI.
 *
 * The current PocketRisu collection was seeded from the PC web collection, so
 * old entries without sourceInfo use 웹 as an explicit baseline fallback. New
 * source-collection imports carry their own label and never hit that fallback.
 */
export function resolveCharacterSourceBadge(value: unknown): ResolvedCharacterSource {
    const raw = typeof value === 'string' ? value.trim() : ''
    const normalized = raw.toLocaleLowerCase().replace(/\s+/g, '')
    if (normalized.includes('모바일') || normalized.includes('mobile')) {
        return { label: '모바일', recorded: true }
    }
    if (normalized.includes('로컬') || normalized.includes('local')) {
        return { label: '로컬', recorded: true }
    }
    if (normalized.includes('웹') || normalized.includes('web')) {
        return { label: '웹', recorded: true }
    }
    return { label: '웹', recorded: false }
}
