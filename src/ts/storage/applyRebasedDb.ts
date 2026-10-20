// A save that meets another device's newer database rebases on it
// (globalApi rebaseTrackedLocalChangesOnLatestServerDb). The merged result
// used to replace the whole database object, so every screen redrew from
// scratch: the open chat flickered, its scroll jumped, and a loaded chat of a
// bot changed elsewhere fell back to a placeholder and loaded again (the
// user's report, 2026-10-21, with the app open on the laptop and the desktop
// at once). The merged result is now brought into the live object in place:
// what holds the same content keeps its object, so only what changed redraws.

import { CATALOG_FIELDS } from '../sync/chatCatalogFields'

/** Which parts differ from the server (the save's hash-mismatch report); null: anything may. */
export interface RebaseChangedParts {
    roots: ReadonlySet<string> | null
    characters: ReadonlySet<string> | null
}

function isPlainObject(value: unknown): value is Record<string, any> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date) return false
    if (value instanceof Map || value instanceof Set) return false
    return true
}

// Items paired by id, so an inserted or moved entry keeps its object (and its
// rendered row): characters by chaId, chats and modules by id, messages by chatId.
const ID_KEYS = ['chaId', 'id', 'chatId'] as const

function commonIdKey(a: readonly any[], b: readonly any[]): string | null {
    if (a.length === 0 || b.length === 0) return null
    for (const key of ID_KEYS) {
        const seen = new Set<string>()
        let usable = true
        for (const list of [a, b]) {
            seen.clear()
            for (const item of list) {
                const id = isPlainObject(item) ? item[key] : undefined
                if (typeof id !== 'string' || id.length === 0 || seen.has(id)) { usable = false; break }
                seen.add(id)
            }
            if (!usable) break
        }
        if (usable) return key
    }
    return null
}

function replaceContents(target: any[], next: any[]): void {
    if (next.length === target.length && next.every((value, index) => value === target[index])) return
    target.splice(0, target.length, ...next)
}

/**
 * `source`'s content, reusing `target` and everything inside it that already
 * matches. Returns `target` when it was updated in place, otherwise the value
 * to store instead (a primitive, or a value of another kind).
 */
export function reconcileInto(target: any, source: any): any {
    if (target === source) return target
    if (Array.isArray(target) && Array.isArray(source)) {
        const key = commonIdKey(target, source)
        if (key) {
            const byId = new Map(target.map((item) => [item[key], item]))
            replaceContents(target, source.map((item) => {
                const old = byId.get(item[key])
                return old === undefined ? item : reconcileInto(old, item)
            }))
        } else {
            const shared = Math.min(target.length, source.length)
            for (let i = 0; i < shared; i++) {
                const next = reconcileInto(target[i], source[i])
                if (next !== target[i]) target[i] = next
            }
            if (target.length > source.length) target.splice(source.length)
            else if (source.length > target.length) target.push(...source.slice(target.length))
        }
        return target
    }
    if (isPlainObject(target) && isPlainObject(source)) {
        for (const key of Object.keys(target)) {
            if (!(key in source)) delete target[key]
        }
        for (const key of Object.keys(source)) {
            const next = reconcileInto(target[key], source[key])
            if (next !== target[key]) target[key] = next
        }
        return target
    }
    if (ArrayBuffer.isView(target) && ArrayBuffer.isView(source) && target.byteLength === source.byteLength) {
        const a = new Uint8Array(target.buffer, target.byteOffset, target.byteLength)
        const b = new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        if (a.every((byte, i) => byte === b[i])) return target
    }
    return source
}

const isLoadedChat = (chat: any) => isPlainObject(chat) && !chat._placeholder && !chat._stub && Array.isArray(chat.message)

/**
 * A character brought to `source` in place. A chat loaded here keeps its body
 * and object; only its catalog fields follow the source, as when a live patch
 * lands (remoteDbPatch). Its body has its own sync (chat ETags), and the
 * source only holds a placeholder for it.
 */
function reconcileCharacter(target: Record<string, any>, source: Record<string, any>): void {
    for (const key of Object.keys(target)) {
        if (!(key in source)) delete target[key]
    }
    for (const key of Object.keys(source)) {
        if (key === 'chats' && Array.isArray(target.chats) && Array.isArray(source.chats)) {
            const byId = new Map<string, any>()
            for (const chat of target.chats) if (typeof chat?.id === 'string') byId.set(chat.id, chat)
            replaceContents(target.chats, source.chats.map((chat: any) => {
                const old = typeof chat?.id === 'string' ? byId.get(chat.id) : undefined
                if (old === undefined) return chat
                if (isLoadedChat(old) && !isLoadedChat(chat)) {
                    for (const field of CATALOG_FIELDS) {
                        if (field in chat) {
                            const next = reconcileInto(old[field], chat[field])
                            if (next !== old[field]) old[field] = next
                        } else if (field in old) {
                            delete old[field]
                        }
                    }
                    return old
                }
                return reconcileInto(old, chat)
            }))
            continue
        }
        const next = reconcileInto(target[key], source[key])
        if (next !== target[key]) target[key] = next
    }
}

/**
 * Bring the live database to the rebased `merged` one in place. Only the root
 * keys and characters in `changed` are compared (all of them when it does not
 * know); a character missing from `merged` leaves, a new one joins, and the
 * characters keep `merged`'s order. Root keys `merged` lacks stay: they are
 * defaults this page filled in at boot.
 */
export function applyMergedDbInPlace(target: Record<string, any>, merged: Record<string, any>, changed: RebaseChangedParts = { roots: null, characters: null }): void {
    for (const key of Object.keys(merged)) {
        if (key === 'characters') continue
        if (changed.roots && !changed.roots.has(key) && key in target) continue
        const next = reconcileInto(target[key], merged[key])
        if (next !== target[key]) target[key] = next
    }

    const mergedCharacters: any[] = Array.isArray(merged.characters) ? merged.characters : []
    if (!Array.isArray(target.characters)) {
        target.characters = mergedCharacters
        return
    }
    const live = new Map<string, any>()
    for (const character of target.characters) {
        if (typeof character?.chaId === 'string') live.set(character.chaId, character)
    }
    replaceContents(target.characters, mergedCharacters.map((character) => {
        const old = typeof character?.chaId === 'string' ? live.get(character.chaId) : undefined
        if (old === undefined) return character
        if (changed.characters && !changed.characters.has(character.chaId)) return old
        if (isPlainObject(old) && isPlainObject(character)) reconcileCharacter(old, character)
        else return character
        return old
    }))
}

/** The parts a save's hash-mismatch report names; null when it cannot tell (duplicate ids, no report). */
export function changedPartsFromReport(report: {
    roots: { mismatched: readonly string[], onlyLocal: readonly string[], onlyRemote: readonly string[] }
    characters: { mismatched: readonly string[], onlyLocal: readonly string[], onlyRemote: readonly string[] }
    duplicateCharIds: readonly string[]
    serverDuplicateCharIds: readonly string[]
} | null | undefined): RebaseChangedParts | null {
    if (!report || report.duplicateCharIds.length > 0 || report.serverDuplicateCharIds.length > 0) return null
    const all = (part: { mismatched: readonly string[], onlyLocal: readonly string[], onlyRemote: readonly string[] }) =>
        new Set([...part.mismatched, ...part.onlyLocal, ...part.onlyRemote])
    return { roots: all(report.roots), characters: all(report.characters) }
}
