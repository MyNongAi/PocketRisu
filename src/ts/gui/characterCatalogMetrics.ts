import { sha256HexPortable } from '../cryptoFallback'
import { findHighSimilarityNameGroups } from '../sourceCollectionDuplicates'

type CatalogCharacter = object & {
    chaId?: string
    trashTime?: number
}

type NamedCharacter = { chaId?: string, name?: string, trashTime?: number, trashedAt?: number } | null | undefined

/**
 * The old catalog's count, "active / all" (the user's request, 2026-10-25):
 * live bots, then those plus the deactivated ones, whether the deactivated
 * are shown or hidden. The trash counts in neither; a search narrows both.
 */
export function countCatalogCharacters(
    characters: readonly NamedCharacter[],
    archived: readonly NamedCharacter[],
    matches: (name: string) => boolean = () => true,
): { active: number, all: number } {
    let active = 0
    for (const character of characters) {
        if (character && !character.trashTime && matches(character.name ?? '')) active++
    }
    let deactivated = 0
    for (const stub of archived) {
        if (stub?.chaId && !stub.trashedAt && matches(stub.name ?? '')) deactivated++
    }
    return { active, all: active + deactivated }
}

type ArchivedMetricStub = {
    chaId?: string
    trashedAt?: number
    exactDefinitionFingerprint?: string
}

// Keep this in lockstep with tools/quarantine-exact-character-duplicates.cjs.
// These values describe a local copy or its play state rather than the card
// definition. Every other field, including ordered lore and asset references,
// contributes to the fingerprint.
const COPY_OR_SESSION_FIELDS = new Set([
    'chaId',
    'chats',
    'chatFolders',
    'chatPage',
    'coldstorage',
    'coldStoragedChats',
    'scriptstate',
    'firstMsgIndex',
    'sourceInfo',
    'trashTime',
    'lastInteraction',
    'creation_date',
    'modification_date',
    'imported',
])

function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
            .sort()
            .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
    )
}

function definitionSignature(character: CatalogCharacter): string {
    const definition: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(character as Record<string, unknown>)) {
        if (!COPY_OR_SESSION_FIELDS.has(key)) definition[key] = value
    }
    return JSON.stringify(stable(definition))
}

/** Exact-definition SHA-256 used only for catalog grouping, never deletion. */
export function exactCharacterDefinitionFingerprint(character: CatalogCharacter): string {
    return sha256HexPortable(new TextEncoder().encode(definitionSignature(character)))
}

export interface DuplicateIndexOptions {
    yieldEvery?: number
    shouldContinue?: () => boolean
}

function yieldToBrowser(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Builds an O(total definition bytes) index. It never compares every character
 * with every other character, and yields between small batches so opening a
 * 1,000+ character catalog does not monopolize the UI thread.
 *
 * The returned number is the count of *other* exact copies for each character.
 */
export async function buildExactCharacterDuplicateCounts(
    characters: readonly CatalogCharacter[],
    archived: readonly ArchivedMetricStub[] = [],
    options: DuplicateIndexOptions = {},
): Promise<Map<string, number>> {
    const yieldEvery = Math.max(1, Math.floor(options.yieldEvery ?? 12))
    const shouldContinue = options.shouldContinue ?? (() => true)
    const groups = new Map<string, string[]>()
    let processed = 0

    const add = (fingerprint: string, chaId: string) => {
        const ids = groups.get(fingerprint) ?? []
        ids.push(chaId)
        groups.set(fingerprint, ids)
    }

    for (const character of characters) {
        if (!shouldContinue()) return new Map()
        if (!character?.chaId || character.trashTime) continue
        add(exactCharacterDefinitionFingerprint(character), character.chaId)
        processed++
        if (processed % yieldEvery === 0) await yieldToBrowser()
    }

    for (const stub of archived) {
        if (!stub?.chaId || stub.trashedAt || !/^[0-9a-f]{64}$/i.test(stub.exactDefinitionFingerprint ?? '')) continue
        add(stub.exactDefinitionFingerprint!, stub.chaId)
    }

    const counts = new Map<string, number>()
    for (const ids of groups.values()) {
        const otherCopies = Math.max(0, ids.length - 1)
        for (const id of ids) counts.set(id, otherCopies)
    }
    return counts
}

type SimilarityCatalogEntry = { chaId?: string, name?: unknown, trashTime?: number, trashedAt?: number } | null | undefined

let similarityCache: { key: string, counts: Map<string, number> } | null = null

/**
 * "유사 N": how many other bots have a name 90% or more alike, live and
 * deactivated together, the trash left out (findHighSimilarityNameGroups,
 * which the [유사 후보] folders are made with). Judged on the names, not on
 * the folders, so a bot taken out of its candidate folder keeps the mark
 * (the user's request, 2026-10-26). The last result is reused while the
 * names stay the same.
 */
export function buildCharacterNameSimilarityCounts(
    characters: readonly SimilarityCatalogEntry[],
    archived: readonly SimilarityCatalogEntry[] = [],
): Map<string, number> {
    const bots: Array<{ chaId: string, name: unknown }> = []
    for (const character of characters) {
        if (character?.chaId && !character.chaId.startsWith('§') && !character.trashTime) bots.push({ chaId: character.chaId, name: character.name })
    }
    for (const stub of archived) {
        if (stub?.chaId && !stub.trashedAt) bots.push({ chaId: stub.chaId, name: stub.name })
    }
    const key = bots.map((bot) => `${bot.chaId}\u0001${typeof bot.name === 'string' ? bot.name : ''}`).join('\u0002')
    if (similarityCache?.key === key) return similarityCache.counts
    const counts = new Map<string, number>()
    for (const group of findHighSimilarityNameGroups(bots)) {
        const ids = new Set(group.members.map((bot) => bot.chaId))
        if (ids.size < 2) continue
        for (const id of ids) counts.set(id, Math.max(counts.get(id) ?? 0, ids.size - 1))
    }
    similarityCache = { key, counts }
    return counts
}

let trashSimilarityCache: { key: string, counts: Map<string, number> } | null = null

/** The trash's "유사 N" tooltip. */
export const TRASH_SIMILARITY_TITLE = '휴지통 밖에 이름 유사도 90% 이상인 봇'

/**
 * "유사 N" in the trash: for a bot in the trash, how many bots outside it
 * (live or deactivated) have a name 90% or more alike, grouped as above, so
 * the trash shows whether a near copy is kept before a bot is deleted for
 * good (the user's request, 2026-10-31). Other bots in the trash are not
 * counted: a copy that is also on its way out keeps nothing.
 */
export function buildTrashNameSimilarityCounts(
    characters: readonly SimilarityCatalogEntry[],
    archived: readonly SimilarityCatalogEntry[] = [],
): Map<string, number> {
    const bots: Array<{ chaId: string, name: unknown, trashed: boolean }> = []
    for (const character of characters) {
        if (character?.chaId && !character.chaId.startsWith('§')) bots.push({ chaId: character.chaId, name: character.name, trashed: !!character.trashTime })
    }
    for (const stub of archived) {
        if (stub?.chaId) bots.push({ chaId: stub.chaId, name: stub.name, trashed: !!stub.trashedAt })
    }
    if (!bots.some((bot) => bot.trashed)) return new Map()
    const key = bots.map((bot) => `${bot.chaId}\u0001${bot.trashed ? 1 : 0}\u0001${typeof bot.name === 'string' ? bot.name : ''}`).join('\u0002')
    if (trashSimilarityCache?.key === key) return trashSimilarityCache.counts
    const counts = new Map<string, number>()
    for (const group of findHighSimilarityNameGroups(bots)) {
        const kept = new Set(group.members.filter((bot) => !bot.trashed).map((bot) => bot.chaId)).size
        if (kept === 0) continue
        for (const bot of group.members) {
            if (bot.trashed) counts.set(bot.chaId, kept)
        }
    }
    trashSimilarityCache = { key, counts }
    return counts
}
