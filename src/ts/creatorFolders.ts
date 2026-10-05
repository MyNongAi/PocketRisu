// Folders of one creator's bots on the sidebar rail (the user's request,
// 2026-10-05). Folders the user made, and the generated folders, keep their
// bots: only bots loose at the top level move into a creator folder, and a
// [유사 후보] folder whose bots all share that creator is shown inside it
// (display-only nesting, folderNesting.ts), so other Risu builds still see a
// flat list. A creator folder carries nodeOnlyCreatorKey; new imports of that
// creator join it (placeImportedByCreator).

import type { folder } from './storage/database.svelte'

type OrderEntry = string | folder

export const CREATOR_FOLDER_PREFIX = '[제작자] '

/** Placeholder names that are not one person. */
const ANONYMOUS = new Set(['ㅇㅇ', '익명', 'anonymous', 'anon', 'unknown', 'none', 'null', 'undefined', '-', '?', '.', 'user', 'risu'])

/** The creator as a grouping key: spacing and case folded; '' for none or a placeholder. */
export function creatorKey(raw: unknown): string {
    const name = typeof raw === 'string' ? raw.normalize('NFC').replace(/\s+/g, ' ').trim() : ''
    const key = name.toLocaleLowerCase()
    return !key || ANONYMOUS.has(key) ? '' : key
}

export interface CreatorOf {
    key: string
    /** The creator as written on the card, for the folder name. */
    name: string
}

/** chaId → creator, for the characters that name one. */
export function creatorsOf(characters: readonly ({ chaId?: string, creator?: unknown } | null | undefined)[]): Map<string, CreatorOf> {
    const map = new Map<string, CreatorOf>()
    for (const character of characters) {
        if (!character?.chaId) continue
        const key = creatorKey(character.creator)
        if (key) map.set(character.chaId, { key, name: String(character.creator).replace(/\s+/g, ' ').trim() })
    }
    return map
}

function isFolder(entry: OrderEntry): entry is folder {
    return typeof entry !== 'string'
}

function isSimilarityFolder(entry: folder): boolean {
    return (entry as folder & { duplicateCandidate?: { kind?: string } }).duplicateCandidate?.kind === 'character'
}

/** The one creator every bot of a folder shares, or '' when they differ or one is unknown. */
function sharedCreator(entry: folder, creators: ReadonlyMap<string, CreatorOf>): string {
    let key = ''
    for (const id of entry.data) {
        const creator = creators.get(id)?.key ?? ''
        if (!creator || (key && creator !== key)) return ''
        key = creator
    }
    return key
}

/**
 * Groups the loose top-level bots of each creator into a creator folder,
 * placed where the creator's first bot or folder was, and shows inside it the
 * [유사 후보] folders made only of that creator's bots. A creator gets a
 * folder for two or more such entries; an existing creator folder takes any.
 * Returns the order unchanged (same array) when nothing moves.
 */
export function organizeCreatorFolders(
    order: readonly OrderEntry[],
    creators: ReadonlyMap<string, CreatorOf>,
    createId: () => string,
): OrderEntry[] {
    const existing = new Map<string, folder>()
    for (const entry of order) {
        if (isFolder(entry) && entry.nodeOnlyCreatorKey) existing.set(entry.nodeOnlyCreatorKey, entry)
    }
    const folderIds = new Set(order.filter(isFolder).map((entry) => entry.id))
    const loose = new Map<string, { ids: string[], first: number }>()
    const nestable = new Map<string, { ids: string[], first: number }>()
    order.forEach((entry, index) => {
        if (!isFolder(entry)) {
            const key = creators.get(entry)?.key
            if (!key) return
            const group = loose.get(key) ?? { ids: [], first: index }
            group.ids.push(entry)
            loose.set(key, group)
            return
        }
        if (!isSimilarityFolder(entry) || entry.nodeOnlySystem || entry.data.length === 0) return
        // Already shown inside another folder that still exists: leave it there.
        if (entry.nodeOnlyParentFolderId && folderIds.has(entry.nodeOnlyParentFolderId)) return
        const key = sharedCreator(entry, creators)
        if (!key) return
        const group = nestable.get(key) ?? { ids: [], first: index }
        group.ids.push(entry.id)
        nestable.set(key, group)
    })

    const moveInto = new Map<string, string>()    // loose chaId → creator folder id
    const nestUnder = new Map<string, string>()   // similarity folder id → creator folder id
    const added = new Map<string, string[]>()     // existing creator folder id → chaIds to append
    const created = new Map<number, folder>()     // order index → new creator folder placed there
    for (const key of new Set([...loose.keys(), ...nestable.keys()])) {
        const bots = loose.get(key)
        const folders = nestable.get(key)
        const count = (bots?.ids.length ?? 0) + (folders?.ids.length ?? 0)
        const target = existing.get(key)
        if (!target && count < 2) continue
        if (target && count === 0) continue
        const id = target?.id ?? createId()
        if (target) {
            if (bots) added.set(target.id, bots.ids)
        } else {
            const name = creators.get(bots?.ids[0] ?? '')?.name
                ?? creators.get((order.find((entry) => isFolder(entry) && entry.id === folders?.ids[0]) as folder | undefined)?.data[0] ?? '')?.name
                ?? key
            const first = Math.min(bots?.first ?? Infinity, folders?.first ?? Infinity)
            created.set(first, { id, name: `${CREATOR_FOLDER_PREFIX}${name}`, color: '', data: bots ? [...bots.ids] : [], nodeOnlyCreatorKey: key })
        }
        for (const chaId of bots?.ids ?? []) moveInto.set(chaId, id)
        for (const folderId of folders?.ids ?? []) nestUnder.set(folderId, id)
    }
    if (moveInto.size === 0 && nestUnder.size === 0) return order as OrderEntry[]

    const next: OrderEntry[] = []
    order.forEach((entry, index) => {
        const placed = created.get(index)
        if (placed) next.push(placed)
        if (!isFolder(entry)) {
            if (!moveInto.has(entry)) next.push(entry)
            return
        }
        const parent = nestUnder.get(entry.id)
        const extra = added.get(entry.id)
        if (!parent && !extra) {
            next.push(entry)
            return
        }
        next.push({
            ...entry,
            data: extra ? [...entry.data, ...extra.filter((id) => !entry.data.includes(id))] : [...entry.data],
            ...(parent ? { nodeOnlyParentFolderId: parent } : {}),
        })
    })
    return next
}

/**
 * A newly imported bot joins its creator's folder when there is one: a loose
 * bot moves in at the front, and the [유사 후보] folder the import may have
 * made of that creator's bots is shown inside it. Returns the order unchanged
 * (same array) when nothing applies.
 */
export function placeImportedByCreator(
    order: readonly OrderEntry[],
    chaId: string,
    creators: ReadonlyMap<string, CreatorOf>,
): OrderEntry[] {
    const key = creators.get(chaId)?.key
    if (!key) return order as OrderEntry[]
    const target = order.find((entry): entry is folder => isFolder(entry) && entry.nodeOnlyCreatorKey === key)
    if (!target) return order as OrderEntry[]
    if (order.includes(chaId)) {
        return order.flatMap((entry): OrderEntry[] => {
            if (entry === chaId) return []
            if (isFolder(entry) && entry.id === target.id) return [{ ...entry, data: [chaId, ...entry.data.filter((id) => id !== chaId)] }]
            return [entry]
        })
    }
    const holder = order.find((entry): entry is folder => isFolder(entry) && entry.data.includes(chaId))
    if (!holder || holder.id === target.id || !isSimilarityFolder(holder) || sharedCreator(holder, creators) !== key) return order as OrderEntry[]
    if (holder.nodeOnlyParentFolderId === target.id) return order as OrderEntry[]
    return order.map((entry) => (isFolder(entry) && entry.id === holder.id ? { ...entry, nodeOnlyParentFolderId: target.id } : entry))
}
