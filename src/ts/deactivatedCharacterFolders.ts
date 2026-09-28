/**
 * Deactivated characters in idle-age folders (PocketRisu,
 * CATALOG-DEACTIVATED-FOLDERS).
 *
 * With the option on (the default), `checkCharOrder()` keeps the end of
 * `db.characterOrder` in this shape:
 *
 *   …everything else… | deactivated zone | 7d | 15d | 30d | 60d+
 *
 * - Age folders: four system folders with fixed ids holding every LOOSE
 *   (top-level) deactivated, non-trashed character by idle time
 *   (now − lastInteraction): [0, 15d) → 7, [15d, 30d) → 15, [30d, 60d) → 30,
 *   [60d, ∞) or never used → 60. The 7-day folder therefore also holds manual
 *   deactivations of characters used moments ago. A folder exists only while
 *   it has members.
 * - Deactivated zone: a regular folder whose members are all deactivated
 *   (and that is not a favorite) moves down as a unit, keeping its name,
 *   colour, image and icon, ordered by its newest member, then id. It leaves
 *   the zone as soon as one member is active again.
 * - User folders are never broken up: a deactivated character inside a
 *   regular folder stays there, dimmed, exactly as without the option.
 *
 * Everything here is derived from the order and the stub list: deterministic
 * for a given `now`, idempotent, and monotonic (a stub already in an age
 * folder never moves to a younger one), so devices with skewed clocks cannot
 * move a stub back and forth.
 *
 * Kept free of runtime imports so characterOrder.ts / characterRecentOrder.ts
 * can import the predicates without a cycle.
 */
import type { ArchivedCharacterStub, folder } from './storage/database.svelte'

export const DEACTIVATED_FOLDER_MARKER = 'deactivated' as const

/** Age buckets from top to bottom. The last one also holds never-used characters. */
export const DEACTIVATED_FOLDER_DAYS = [7, 15, 30, 60] as const
export type DeactivatedFolderDays = typeof DEACTIVATED_FOLDER_DAYS[number]

export const DEACTIVATED_FOLDER_IDS: Readonly<Record<DeactivatedFolderDays, string>> = Object.freeze({
    7: 'nodeonly-deactivated-7d',
    15: 'nodeonly-deactivated-15d',
    30: 'nodeonly-deactivated-30d',
    60: 'nodeonly-deactivated-60d',
})

/**
 * Name written into the database. It never depends on the UI language: two
 * devices in different languages would otherwise rewrite each other's order
 * forever. PocketRisu always shows a localized label instead; upstream RisuAI
 * (which ignores nodeOnly fields) shows this one after an export.
 */
export const DEACTIVATED_FOLDER_STORED_NAMES: Readonly<Record<DeactivatedFolderDays, string>> = Object.freeze({
    7: 'Inactive 7d',
    15: 'Inactive 15d',
    30: 'Inactive 30d',
    60: 'Inactive 60d+',
})

/** Bucket ids an unreleased draft wrote. Still recognized, and their members re-bucketed. */
const RETIRED_FOLDER_IDS: ReadonlySet<string> = new Set(['nodeonly-deactivated-3d'])

/** Members of an age folder the lists mount at first, and per "load more". */
export const DEACTIVATED_FOLDER_PAGE_SIZE = 60

const DAY_MS = 24 * 60 * 60 * 1000

const DAYS_BY_ID: ReadonlyMap<string, DeactivatedFolderDays> = new Map(
    DEACTIVATED_FOLDER_DAYS.map((days) => [DEACTIVATED_FOLDER_IDS[days], days]),
)

export type DeactivatedOrderEntry = string | folder

type GroupingSetting = { nodeOnlyGroupDeactivatedCharacters?: boolean }

/** The setting defaults to on for new and existing databases (undefined = on). */
export function isDeactivatedGroupingEnabled(db: GroupingSetting | null | undefined): boolean {
    return db?.nodeOnlyGroupDeactivatedCharacters !== false
}

/**
 * Bucket for a stub by idle time (`now - lastInteraction`). A missing, zero
 * or invalid lastInteraction means never used, i.e. the oldest bucket. A
 * future timestamp (clock skew) counts as fresh.
 */
export function deactivatedFolderDaysFor(lastInteraction: unknown, now: number): DeactivatedFolderDays {
    const last = typeof lastInteraction === 'number' ? lastInteraction : Number(lastInteraction)
    if (!Number.isFinite(last) || last <= 0) return 60
    const idle = now - last
    if (idle >= 60 * DAY_MS) return 60
    if (idle >= 30 * DAY_MS) return 30
    if (idle >= 15 * DAY_MS) return 15
    return 7
}

/** The bucket of a current age-folder id (undefined for anything else, retired ids included). */
export function deactivatedFolderDaysOfId(id: unknown): DeactivatedFolderDays | undefined {
    return typeof id === 'string' ? DAYS_BY_ID.get(id) : undefined
}

export function isDeactivatedSystemFolderId(id: unknown): boolean {
    return typeof id === 'string' && (DAYS_BY_ID.has(id) || RETIRED_FOLDER_IDS.has(id))
}

/**
 * An age folder by its fixed id, or by the marker (buckets written by another
 * build). Deliberately a plain boolean, not a type guard: a guard would narrow
 * the false branch of a `string | folder` union to `string` (or `never`).
 */
export function isDeactivatedSystemFolder(entry: unknown): boolean {
    if (!isFolderObject(entry)) return false
    return isDeactivatedSystemFolderId(entry.id) || entry.nodeOnlySystem === DEACTIVATED_FOLDER_MARKER
}

/** Bucket to label an age folder with until the next check re-buckets a retired or foreign one. */
export function deactivatedFolderDisplayDays(entry: folder): DeactivatedFolderDays {
    return deactivatedFolderDaysOfId(entry.id) ?? (RETIRED_FOLDER_IDS.has(entry.id) ? 7 : 60)
}

function isFolderObject(entry: unknown): entry is folder {
    return !!entry && typeof entry === 'object' && Array.isArray((entry as folder).data)
}

/** chaIds of deactivated characters that are not in the trash (the ones the lists show dimmed). */
export function deactivatedCharacterIds(stubs: readonly (ArchivedCharacterStub | null | undefined)[] | null | undefined): Set<string> {
    const ids = new Set<string>()
    for (const stub of stubs ?? []) {
        if (stub && typeof stub.chaId === 'string' && stub.chaId && !stub.trashedAt) ids.add(stub.chaId)
    }
    return ids
}

/**
 * A regular folder that belongs in the deactivated zone: not an age folder,
 * not a favorite, at least one member, and every member deactivated.
 */
export function isFullyDeactivatedFolder(entry: unknown, isDeactivated: (chaId: string) => boolean): boolean {
    if (!isFolderObject(entry) || isDeactivatedSystemFolder(entry) || entry.favorite) return false
    return entry.data.length > 0 && entry.data.every((id) => isDeactivated(id))
}

function interactionOf(stub: ArchivedCharacterStub | undefined): number {
    const value = Number(stub?.lastInteraction)
    return Number.isFinite(value) && value > 0 ? value : 0
}

/** Code-unit order: identical on every device, unlike localeCompare. */
function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

/** lastInteraction descending, then chaId. */
function compareMembers(left: ArchivedCharacterStub, right: ArchivedCharacterStub): number {
    return (interactionOf(right) - interactionOf(left)) || compareIds(left.chaId, right.chaId)
}

function systemFolder(days: DeactivatedFolderDays, data: string[], existing: folder | undefined): folder {
    // Keep whatever else the stored object carries (key order included, so an
    // unchanged folder compares and hashes equal) but never let it act as a
    // favorite or a similarity-candidate folder.
    const { favorite: _favorite, duplicateCandidate: _candidate, ...kept } = (existing ?? {}) as folder & { duplicateCandidate?: unknown }
    return {
        ...kept,
        id: DEACTIVATED_FOLDER_IDS[days],
        name: DEACTIVATED_FOLDER_STORED_NAMES[days],
        data,
        color: typeof existing?.color === 'string' ? existing.color : '',
        nodeOnlySystem: DEACTIVATED_FOLDER_MARKER,
    }
}

export interface ArrangeDeactivatedFoldersInput {
    /** Order already cleaned of unknown and trashed ids (checkCharOrder's first pass). */
    order: readonly DeactivatedOrderEntry[]
    /** Every stub; trashed ones and ids that are also active are ignored. */
    stubs: readonly ArchivedCharacterStub[]
    /** chaIds of active (non-trashed) characters. */
    activeIds: ReadonlySet<string>
    enabled: boolean
    now: number
}

/**
 * Enabled: loose deactivated characters (top level, in an age folder, or
 * missing from the order) go to their bucket, never younger than the bucket
 * they already sit in. Deactivated characters inside regular folders stay
 * where they are. Fully deactivated regular folders move into the zone.
 * Active characters found in an age folder move out to the top level, just
 * above the zone. The result ends with the zone, then the age folders in
 * 7→60 order.
 *
 * Disabled: the age folders dissolve and their members go loose at the end
 * of the top level; nothing else moves. Without age folders the order is
 * returned as it is.
 *
 * Never mutates its inputs.
 */
export function arrangeDeactivatedFolders(input: ArrangeDeactivatedFoldersInput): DeactivatedOrderEntry[] {
    return input.enabled ? gatherDeactivated(input) : releaseDeactivated(input)
}

function gatherDeactivated(input: ArrangeDeactivatedFoldersInput): DeactivatedOrderEntry[] {
    const stubById = new Map<string, ArchivedCharacterStub>()
    for (const stub of input.stubs) {
        if (!stub || typeof stub.chaId !== 'string' || !stub.chaId || stub.trashedAt || input.activeIds.has(stub.chaId)) continue
        if (!stubById.has(stub.chaId)) stubById.set(stub.chaId, stub)
    }
    const isDeactivated = (id: string) => stubById.has(id)

    // Where ids sit outside the age folders. A regular folder keeps its
    // members whatever else holds them; an id placed elsewhere is not
    // duplicated from an age folder.
    const inUserFolder = new Set<string>()
    const loose = new Set<string>()
    for (const entry of input.order) {
        if (typeof entry === 'string') loose.add(entry)
        else if (isFolderObject(entry) && !isDeactivatedSystemFolder(entry)) {
            for (const id of entry.data) inUserFolder.add(id)
        }
    }

    const rest: DeactivatedOrderEntry[] = []
    const zone: folder[] = []
    const existingFolders = new Map<DeactivatedFolderDays, folder>()
    // Oldest age folder each stub already sits in: re-bucketing never goes back.
    const floors = new Map<string, DeactivatedFolderDays>()
    const gathered = new Set<string>()
    const released = new Set<string>()

    for (const entry of input.order) {
        if (typeof entry === 'string') {
            if (!isDeactivated(entry)) rest.push(entry)
            else if (!inUserFolder.has(entry)) gathered.add(entry)
            continue
        }
        if (!isFolderObject(entry)) continue
        if (isDeactivatedSystemFolder(entry)) {
            const days = deactivatedFolderDaysOfId(entry.id)
            if (days !== undefined && !existingFolders.has(days)) existingFolders.set(days, entry)
            for (const id of entry.data) {
                if (inUserFolder.has(id)) continue
                if (isDeactivated(id)) {
                    gathered.add(id)
                    if (days !== undefined && days > (floors.get(id) ?? 0)) floors.set(id, days)
                } else if (input.activeIds.has(id) && !loose.has(id)) {
                    released.add(id)
                }
            }
            continue
        }
        if (isFullyDeactivatedFolder(entry, isDeactivated)) zone.push(entry)
        else rest.push(entry)
    }

    // Active characters dragged or synced into an age folder: top level, just above the zone.
    for (const id of released) rest.push(id)
    // Stubs missing from the order (e.g. restored from the trash) join their bucket.
    for (const id of stubById.keys()) {
        if (!inUserFolder.has(id)) gathered.add(id)
    }

    const buckets = new Map<DeactivatedFolderDays, ArchivedCharacterStub[]>()
    for (const id of gathered) {
        const stub = stubById.get(id)
        if (!stub) continue
        const computed = deactivatedFolderDaysFor(stub.lastInteraction, input.now)
        const floor = floors.get(id) ?? computed
        const days = floor > computed ? floor : computed
        const members = buckets.get(days)
        if (members) members.push(stub)
        else buckets.set(days, [stub])
    }

    const newest = new Map<folder, number>()
    for (const entry of zone) {
        newest.set(entry, entry.data.reduce((max, id) => Math.max(max, interactionOf(stubById.get(id))), 0))
    }
    zone.sort((left, right) => (newest.get(right)! - newest.get(left)!) || compareIds(left.id, right.id))

    const folders: folder[] = []
    for (const days of DEACTIVATED_FOLDER_DAYS) {
        const members = buckets.get(days)
        if (!members || members.length === 0) continue
        members.sort(compareMembers)
        folders.push(systemFolder(days, members.map((stub) => stub.chaId), existingFolders.get(days)))
    }

    return [...rest, ...zone, ...folders]
}

function releaseDeactivated(input: ArrangeDeactivatedFoldersInput): DeactivatedOrderEntry[] {
    if (!input.order.some((entry) => isDeactivatedSystemFolder(entry))) return input.order.slice()
    const rest: DeactivatedOrderEntry[] = []
    const members: string[] = []
    const placed = new Set<string>()
    for (const entry of input.order) {
        if (typeof entry === 'string') {
            rest.push(entry)
            placed.add(entry)
            continue
        }
        if (!isFolderObject(entry)) continue
        if (isDeactivatedSystemFolder(entry)) {
            members.push(...entry.data)
            continue
        }
        rest.push(entry)
        for (const id of entry.data) placed.add(id)
    }
    for (const id of members) {
        if (placed.has(id)) continue
        placed.add(id)
        rest.push(id)
    }
    return rest
}

/**
 * Where a reactivated character goes before the usual recency promotion
 * lifts it (or the regular folder holding it) to the top. One inside a
 * regular folder or at the top level stays put. One in an age folder, or
 * missing, goes to the top level just above the age folders.
 */
export function placeReactivatedCharacter(order: readonly DeactivatedOrderEntry[], chaId: string): DeactivatedOrderEntry[] {
    let placed = false
    let inSystemFolder = false
    for (const entry of order) {
        if (typeof entry === 'string') {
            if (entry === chaId) placed = true
        } else if (isFolderObject(entry) && entry.data.includes(chaId)) {
            if (isDeactivatedSystemFolder(entry)) inSystemFolder = true
            else placed = true
        }
    }
    if (!inSystemFolder && placed) return order.slice()

    const next: DeactivatedOrderEntry[] = []
    for (const entry of order) {
        if (typeof entry === 'string') {
            next.push(entry)
            continue
        }
        if (!isFolderObject(entry)) continue
        if (!isDeactivatedSystemFolder(entry) || !entry.data.includes(chaId)) {
            next.push(entry)
            continue
        }
        const data = entry.data.filter((id) => id !== chaId)
        // An emptied age folder disappears (it only exists with members).
        if (data.length > 0) next.push({ ...entry, data })
    }
    if (placed) return next
    const firstSystem = next.findIndex((entry) => isDeactivatedSystemFolder(entry))
    next.splice(firstSystem === -1 ? next.length : firstSystem, 0, chaId)
    return next
}

/**
 * Index where the managed tail (zone folders, then age folders) starts, or
 * `order.length` when there is none.
 */
export function deactivatedTailStart(order: readonly DeactivatedOrderEntry[], isDeactivated: (chaId: string) => boolean): number {
    let start = order.length
    while (start > 0) {
        const entry = order[start - 1]
        if (!isDeactivatedSystemFolder(entry) && !isFullyDeactivatedFolder(entry, isDeactivated)) break
        start--
    }
    return start
}

/**
 * Whether a manual up/down move of `key` (a chaId or a folder id) would
 * survive the next check. With grouping on, members of an age folder are
 * sorted by idle time, and nothing moves into, out of or within the tail
 * (zone and age folders), whose order is derived. Moves inside a regular
 * folder, zone folders included, stay free.
 */
export function canMoveOrderEntry(
    order: readonly DeactivatedOrderEntry[],
    key: string,
    delta: -1 | 1,
    isDeactivated: (chaId: string) => boolean,
    enabled: boolean,
): boolean {
    if (!enabled) return true
    const tail = deactivatedTailStart(order, isDeactivated)
    const inTail = (index: number) => index >= tail && index < order.length
    for (let index = 0; index < order.length; index++) {
        const entry = order[index]
        const topLevel = typeof entry === 'string' ? entry === key : isFolderObject(entry) && entry.id === key
        if (topLevel) return !inTail(index) && !(delta > 0 && inTail(index + 1))
        if (isFolderObject(entry) && entry.data.includes(key)) return !isDeactivatedSystemFolder(entry)
    }
    return true
}

/**
 * How the sidebar rail shows one characterOrder folder, or null to skip it.
 * With "hide deactivated characters" on, the age folders and any folder
 * whose members are all deactivated disappear from the rail; the data keeps
 * them. `days` is set for an age folder, which the rail draws with its own
 * glyph and localized name.
 */
export function railFolderView(
    entry: folder,
    hideDeactivated: boolean,
    isDeactivated: (chaId: string) => boolean,
): { days?: DeactivatedFolderDays } | null {
    const system = isDeactivatedSystemFolder(entry)
    if (hideDeactivated && (system || (entry.data.length > 0 && entry.data.every((id) => isDeactivated(id))))) return null
    return system ? { days: deactivatedFolderDisplayDays(entry) } : {}
}

/**
 * Whether the character manager shows a folder open. Regular folders start
 * open and remember being collapsed; age folders start collapsed and
 * remember being opened (`toggled` is the stored flag, read inverted). While
 * a search or filter narrows the list, every folder holding a match is shown
 * open without touching the stored state: a collapsed folder would show only
 * its match count, never the matches.
 */
export function isManagerFolderOpen(
    entry: folder,
    toggled: boolean,
    narrowing: boolean,
    visibleCount: number,
): boolean {
    const system = isDeactivatedSystemFolder(entry)
    if (narrowing && visibleCount > 0) return true
    return toggled === system
}
