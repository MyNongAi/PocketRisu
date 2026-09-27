/**
 * The body of `checkCharOrder()` (globalApi.svelte.ts), kept free of the app
 * runtime so it can be tested against a plain database object.
 *
 * Makes `db.characterOrder` consistent with the character lists: every active
 * character and deactivated stub appears once, unknown ids are dropped,
 * singleton folders dissolve, favorites lead, and — unless the user turned it
 * off — loose deactivated characters are gathered into the idle-age folders
 * at the bottom, with fully deactivated folders just above them
 * (deactivatedCharacterFolders.ts).
 *
 * Works on a detached copy and writes back only what actually changed: every
 * write to the reactive database schedules a save, and this runs on many
 * paths plus an hourly timer, so a run that changes nothing must write nothing.
 */
import isEqual from 'lodash/isEqual'
import { dissolveSingletonFolders, pruneHiddenCharacterIds, type OrderEntry } from './characterOrder'
import { normalizeCharacterFavoriteOrder } from './characterRecentOrder'
import { arrangeDeactivatedFolders, isDeactivatedGroupingEnabled } from './deactivatedCharacterFolders'
import type { ArchivedCharacterStub, character } from './storage/database.svelte'

export interface CharacterOrderDatabase {
    characters: character[]
    characterOrder?: OrderEntry[]
    nodeOnlyArchivedCharacters?: ArchivedCharacterStub[]
    nodeOnlyHiddenCharacterIds?: string[]
    nodeOnlyGroupDeactivatedCharacters?: boolean
}

export interface CharacterOrderCheckOptions {
    /** Clock for the idle-age buckets (tests); defaults to Date.now(). */
    now?: number
}

/** Returns true when anything in `db` was written. */
export function applyCharacterOrderCheck(db: CharacterOrderDatabase, options: CharacterOrderCheckOptions = {}): boolean {
    const now = typeof options?.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now()
    let wrote = false
    if (!Array.isArray(db.characterOrder)) {
        db.characterOrder = []
        wrote = true
    }
    const currentOrder = db.characterOrder
    const previousOrder: OrderEntry[] = currentOrder.flatMap((entry): OrderEntry[] => {
        if (typeof entry === 'string') return [entry]
        if (!entry) return []
        return [{ ...entry, data: Array.isArray(entry.data) ? [...entry.data] : [] }]
    })
    const order: OrderEntry[] = previousOrder.map((entry) => (
        typeof entry === 'string' ? entry : { ...entry, data: [...entry.data] }
    ))
    const grouping = isDeactivatedGroupingEnabled(db)
    const stubs = Array.isArray(db.nodeOnlyArchivedCharacters) ? db.nodeOnlyArchivedCharacters : []

    const ordered = new Set<string>()
    for (const entry of order) {
        if (typeof entry === 'string') ordered.add(entry)
        else for (const id of entry.data) ordered.add(id)
    }

    const charIdSet = new Set<string>()
    const activeIds = new Set<string>()
    for (const char of db.characters) {
        const charId = char.chaId
        if (!char.trashTime) {
            charIdSet.add(charId)
            activeIds.add(charId)
        }
        if (!ordered.has(charId) && charId !== '§temp' && charId !== '§playground' && !char.trashTime) {
            order.push(charId)
            ordered.add(charId)
        }
    }
    // Deactivated characters are not in db.characters but stay in the order
    // so the lists can render them dimmed.
    for (const stub of stubs) {
        if (!stub?.chaId) continue
        // Trashed stubs (deactivated + trashedAt) leave the order like trashed characters.
        if (stub.trashedAt) continue
        charIdSet.add(stub.chaId)
        // With grouping on, arrangeDeactivatedFolders files a missing stub
        // into its age folder instead.
        if (!grouping && !ordered.has(stub.chaId)) {
            order.push(stub.chaId)
            ordered.add(stub.chaId)
        }
    }

    // Empty folders are kept: the character manager creates a folder first
    // and fills it afterwards.
    const cleaned: OrderEntry[] = []
    for (const entry of order) {
        if (typeof entry === 'string') {
            if (charIdSet.has(entry)) cleaned.push(entry)
            continue
        }
        const data = entry.data.filter((id) => charIdSet.has(id))
        cleaned.push(data.length === entry.data.length ? entry : { ...entry, data })
    }

    // Singletons dissolve before the arrangement so a folder left with one
    // deactivated member lands in its age folder in this same run.
    const arranged = arrangeDeactivatedFolders({
        order: dissolveSingletonFolders(cleaned, previousOrder), stubs, activeIds, enabled: grouping, now,
    })
    const next = normalizeCharacterFavoriteOrder(
        arranged,
        new Set(db.characters.filter((char) => char.favorite && !char.trashTime).map((char) => char.chaId)),
    )
    if (!isEqual(next, currentOrder)) {
        db.characterOrder = next
        wrote = true
    }

    // Sidebar-hidden ids: drop only ids that exist nowhere any more (trashed
    // characters keep their flag so restoring them restores the hidden state).
    if (Array.isArray(db.nodeOnlyHiddenCharacterIds) && db.nodeOnlyHiddenCharacterIds.length > 0) {
        const known = new Set<string>(charIdSet)
        for (const char of db.characters) {
            if (char?.chaId) known.add(char.chaId)
        }
        for (const stub of stubs) {
            if (stub?.chaId) known.add(stub.chaId)
        }
        const pruned = pruneHiddenCharacterIds(db.nodeOnlyHiddenCharacterIds, known)
        if (pruned.length !== db.nodeOnlyHiddenCharacterIds.length) {
            db.nodeOnlyHiddenCharacterIds = pruned
            wrote = true
        }
    }
    return wrote
}
