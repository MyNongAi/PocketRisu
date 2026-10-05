export type CharacterSourceBadge = '로컬' | '웹' | '모바일' | '포켓' | '렐름' | '프로톤'

export interface ResolvedCharacterSource {
    label: CharacterSourceBadge
    /** False for legacy characters that predate sourceInfo tracking. */
    recorded: boolean
}

/** What this install itself recorded about where an item came from. */
export interface LocalOrigin {
    /** When this install brought it in (a bot's or module's importedAt, a persona's createdAt). */
    stamp?: number
    /** Downloaded from RisuRealm (a bot's realmId). */
    realm?: boolean
    /** Downloaded from a Proton Drive link (protonSource.ts). */
    proton?: boolean
}

/** The LocalOrigin of a bot, deactivated stub, module or persona. */
export function localOriginOf(item: {
    importedAt?: number
    createdAt?: number
    realmId?: string
    nodeOnlyProtonSource?: unknown
    nodeOnlyProtonShare?: string
} | null | undefined): LocalOrigin {
    if (!item) return {}
    return {
        stamp: item.importedAt ?? item.createdAt,
        realm: !!item.realmId,
        proton: !!item.nodeOnlyProtonSource || !!item.nodeOnlyProtonShare,
    }
}

/**
 * Collapse verbose collection labels into the origins used by the UI.
 *
 * The current PocketRisu collection was seeded from the PC web collection, so
 * old entries without sourceInfo use 웹 as an explicit baseline fallback. New
 * source-collection imports carry their own label and never hit that fallback.
 *
 * Without a collection label, what this install itself brought in (`local`,
 * only PocketRisu records it) shows where it came from: 프로톤 for a Proton
 * download, 렐름 for a Realm download, 포켓 for anything else made or imported
 * here (the user's request, 2026-10-05), instead of the 웹 guess.
 */
export function resolveCharacterSourceBadge(value: unknown, local: LocalOrigin = {}): ResolvedCharacterSource {
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
    if (local.proton) return { label: '프로톤', recorded: true }
    if (typeof local.stamp === 'number' && local.stamp > 0) {
        return { label: local.realm ? '렐름' : '포켓', recorded: true }
    }
    return { label: '웹', recorded: false }
}
