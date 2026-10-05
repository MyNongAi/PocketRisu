/**
 * Which Risu an item came from (the user's terms, 2026-10-05): the PC web
 * Risu (웹), the mobile web Risu (모바일), the local Risu (로컬), or this
 * PocketRisu (포켓). Where a bot was downloaded from (Realm, Proton) is not
 * a badge; it is bot information (downloadPlaceOf), shown in its info popup.
 */
export type CharacterSourceBadge = '로컬' | '웹' | '모바일' | '포켓'

export interface ResolvedCharacterSource {
    label: CharacterSourceBadge
    /** False for legacy characters that predate sourceInfo tracking. */
    recorded: boolean
}

/** What this install itself recorded about an item. */
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
 * Without a collection label, what this install itself brought in (`local`:
 * an import stamp or a Proton download, which only PocketRisu records) shows
 * 포켓 instead of the 웹 guess.
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
    if (local.proton || (typeof local.stamp === 'number' && local.stamp > 0)) {
        return { label: '포켓', recorded: true }
    }
    return { label: '웹', recorded: false }
}

/**
 * Where a bot was downloaded from, for its info popup (not its badge):
 * 프로톤 for a recorded Proton download (with the file), 렐름 for a Realm
 * card, '' when nothing tells.
 */
export function downloadPlaceOf(item: {
    realmId?: string
    nodeOnlyProtonSource?: { file?: string }
    nodeOnlyProtonShare?: string
} | null | undefined): string {
    if (!item) return ''
    if (item.nodeOnlyProtonSource || item.nodeOnlyProtonShare) {
        const file = item.nodeOnlyProtonSource?.file
        return file ? `프로톤 (${file})` : '프로톤'
    }
    return item.realmId ? '렐름' : ''
}
