// Recount each card's missing assets from the files that exist, and sort the
// cards of one import source by the result.
//
// The count a card carries (sourceInfo.missingAssetCount) is written once, at
// import or by a Realm recovery, and goes stale. On 2026-10-02, 45 cards from
// the 8/30 mobile-web backup still had 0 recorded while 15,089 of their asset
// files were missing: their titles were not red, and the Realm folder
// recovery skipped them as healthy. Counting again from the server's asset
// index fixes both.
//
// The sort (asked for by the user the same day) keeps a source's cards apart
// by state: healthy cards stay in "[출처] <label>", cards a Realm recovery
// restored go to "[복구] <label>", cards with missing assets to
// "[에셋 누락] <label>" (where the Realm folder recovery picks them up), and
// nameless cards with nothing in them to "[출처] <label> · 빈 봇". Cards in a
// [유사 후보] review folder, the Proton folder or any folder the user made are
// left where they are.

import type { CharacterRecoveryOrderEntry } from './characterRecoveryFolders'

export interface AssetHealthCount {
    /** References the server reports missing. */
    missing: number
    /** References checked (assets/… and external://…; other kinds cannot be checked). */
    total: number
    /** References whose check failed; counted neither way. */
    unknown: number
}

type AssetTuple = [string, string, string] | [string, string] | string[]

interface AssetOwner {
    chaId: string
    image?: string
    emotionImages?: Array<[string, string] | string[]>
    additionalAssets?: AssetTuple[]
    /**
     * In the app the additional-asset list is usually not in memory: the boot
     * payload carries only this descriptor and the list loads on demand. A
     * count that read `additionalAssets` alone saw none of it (2026-10-03:
     * 1,806 references instead of ~200,000, and 542 counts written too low).
     */
    additionalAssetManifest?: unknown
    ccAssets?: Array<{ uri?: string }>
}

const isCheckable = (reference: unknown): reference is string => (
    typeof reference === 'string' && (reference.startsWith('assets/') || reference.startsWith('external://'))
)

/** Every asset slot of a card (profile, emotions, additional assets, card assets), as the Realm recovery sees them. */
export function characterAssetReferences(character: AssetOwner): string[] {
    const references: unknown[] = [character.image]
    for (const item of character.emotionImages ?? []) references.push(item?.[1])
    for (const item of character.additionalAssets ?? []) references.push(item?.[1])
    for (const item of character.ccAssets ?? []) references.push(item?.uri)
    return references.filter(isCheckable)
}

export type InspectAssets = (paths: string[]) => Promise<Array<{ path: string, status: string }>>

export interface CountOptions {
    /** The server takes at most 128 references per request. */
    batchSize?: number
    /** The server runs at most two inspections at once and answers 429 beyond that. */
    concurrency?: number
    attempts?: number
    signal?: AbortSignal
    onProgress?: (checked: number, total: number) => void
    /** Loading the lazy additional-asset lists: (loaded, total). */
    onListProgress?: (loaded: number, total: number) => void
    sleep?: (ms: number) => Promise<void>
    /**
     * The full additional-asset list of a card that only carries
     * `additionalAssetManifest`. Without it, or when it fails, such a card
     * gets no count at all (its record and place are left alone).
     */
    loadAdditionalAssets?: (character: AssetOwner) => Promise<AssetTuple[]>
}

/** The card's complete additional-asset list, or null when it cannot be known. */
async function fullAdditionalAssets(character: AssetOwner, options: CountOptions): Promise<AssetTuple[] | null> {
    if (Array.isArray(character.additionalAssets)) return character.additionalAssets
    if (!character.additionalAssetManifest) return []
    if (!options.loadAdditionalAssets) return null
    try {
        const items = await options.loadAdditionalAssets(character)
        return Array.isArray(items) ? items : null
    } catch {
        return null
    }
}

/** Ask the server about every distinct reference once, then count per card. */
export async function countAssetHealth(
    characters: readonly AssetOwner[],
    inspect: InspectAssets,
    options: CountOptions = {},
): Promise<Map<string, AssetHealthCount>> {
    const batchSize = options.batchSize ?? 128
    const concurrency = options.concurrency ?? 2
    const attempts = options.attempts ?? 5
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

    const perCharacter = new Map<string, string[]>()
    const unique = new Set<string>()
    let listed = 0
    let nextCharacter = 0
    options.onListProgress?.(0, characters.length)
    const listWorker = async () => {
        while (nextCharacter < characters.length) {
            if (options.signal?.aborted) throw new DOMException('Asset count canceled.', 'AbortError')
            const character = characters[nextCharacter++]
            const additionalAssets = await fullAdditionalAssets(character, options)
            listed++
            options.onListProgress?.(listed, characters.length)
            if (!additionalAssets) continue
            const references = characterAssetReferences({ ...character, additionalAssets })
            perCharacter.set(character.chaId, references)
            for (const reference of references) unique.add(reference)
        }
    }
    await Promise.all(Array.from({ length: Math.min(4, characters.length) }, listWorker))
    const all = [...unique]
    const batches: string[][] = []
    for (let i = 0; i < all.length; i += batchSize) batches.push(all.slice(i, i + batchSize))

    const status = new Map<string, string>()
    let checked = 0
    let nextBatch = 0
    options.onProgress?.(0, all.length)
    const worker = async () => {
        while (nextBatch < batches.length) {
            if (options.signal?.aborted) throw new DOMException('Asset count canceled.', 'AbortError')
            const batch = batches[nextBatch++]
            let results: Awaited<ReturnType<InspectAssets>> | null = null
            for (let attempt = 1; attempt <= attempts && !results; attempt++) {
                try {
                    results = await inspect(batch)
                } catch {
                    // 429 while another inspection runs, or a dropped link: wait and retry.
                    if (attempt < attempts) await sleep(500 * attempt)
                }
            }
            for (let i = 0; i < batch.length; i++) status.set(batch[i], results?.[i]?.status ?? 'error')
            checked += batch.length
            options.onProgress?.(checked, all.length)
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker))

    const counts = new Map<string, AssetHealthCount>()
    for (const [chaId, references] of perCharacter) {
        const count: AssetHealthCount = { missing: 0, total: references.length, unknown: 0 }
        for (const reference of references) {
            const state = status.get(reference)
            if (state === 'missing') count.missing++
            else if (state !== 'exists') count.unknown++
        }
        counts.set(chaId, count)
    }
    return counts
}

export type SortBucket = 'healthy' | 'recovered' | 'missing' | 'empty'

export function sourceSortFolders(label: string): Record<SortBucket, string> {
    return {
        healthy: `[출처] ${label}`,
        recovered: `[복구] ${label}`,
        missing: `[에셋 누락] ${label}`,
        empty: `[출처] ${label} · 빈 봇`,
    }
}

interface SortCard {
    chaId: string
    name?: string
    trashTime?: number
    sourceInfo?: { label?: string }
}

export interface SourceSortPlan {
    /** chaId → folder name, only for cards that move. */
    assignments: Map<string, string>
    counts: Record<SortBucket, number>
}

/**
 * Where each card of `label` belongs. Only cards in the top-level list or in
 * one of the four sort folders are considered; a card without a count in
 * `health` (not checked) stays put.
 */
export function planSourceSort(args: {
    label: string
    order: readonly CharacterRecoveryOrderEntry[]
    characters: readonly SortCard[]
    health: ReadonlyMap<string, AssetHealthCount>
    /** A Realm source id: set on every card a Realm recovery restored. */
    hasRealmId: (character: SortCard) => boolean
}): SourceSortPlan {
    const folders = sourceSortFolders(args.label)
    const sortFolders = new Set(Object.values(folders))
    const location = new Map<string, string | null>()
    for (const entry of args.order) {
        if (typeof entry === 'string') location.set(entry, null)
        else for (const id of entry.data ?? []) location.set(id, entry.name)
    }
    const plan: SourceSortPlan = { assignments: new Map(), counts: { healthy: 0, recovered: 0, missing: 0, empty: 0 } }
    for (const character of args.characters) {
        if (!character?.chaId || character.trashTime || character.sourceInfo?.label !== args.label) continue
        const health = args.health.get(character.chaId)
        // Not checked, or checked without a clear answer: leave it where it is.
        if (!health || (health.unknown > 0 && health.missing === 0)) continue
        const current = location.get(character.chaId)
        if (current === undefined || (current !== null && !sortFolders.has(current))) continue
        const bucket: SortBucket = health.total === 0 && !String(character.name ?? '').trim() ? 'empty'
            : health.missing > 0 ? 'missing'
            : health.total > 0 && args.hasRealmId(character) ? 'recovered'
            : 'healthy'
        plan.counts[bucket]++
        if (current !== folders[bucket]) plan.assignments.set(character.chaId, folders[bucket])
    }
    return plan
}
