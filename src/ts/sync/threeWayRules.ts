// Value rules for a three-way merge of the database: B is what this page last
// synced, L its live state, R (or S) the server's after another device's
// patch. Each rule either settles a value both sides changed or says it
// cannot (CONFLICT); the caller then refuses the landing and leaves
// everything to the rebase fallback. Pure: no Svelte, no app state.

/** A value both sides changed in ways no rule can combine. */
export const CONFLICT: unique symbol = Symbol('three-way-conflict')
export type Conflict = typeof CONFLICT

/**
 * Deep equality of JSON data. Plain objects compare by own keys in any
 * order (the save hash is order-independent too); arrays compare in order.
 * Identity first: a copy-on-write apply shares every untouched subtree with
 * its baseline, so most comparisons end at the first `===`.
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
    const aIsArray = Array.isArray(a)
    if (aIsArray !== Array.isArray(b)) return false
    if (aIsArray) {
        const left = a as unknown[]
        const right = b as unknown[]
        if (left.length !== right.length) return false
        for (let i = 0; i < left.length; i++) {
            if (!jsonDeepEqual(left[i], right[i])) return false
        }
        return true
    }
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    for (const key of keys) {
        if (!Object.hasOwn(right, key) || !jsonDeepEqual(left[key], right[key])) return false
    }
    return true
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isCounterValue = (value: unknown) => value === undefined || isFiniteNumber(value)
const isBag = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * `statics`: counters every send bumps on both devices, so both deltas are
 * kept, `r + (l - b)` per key (an absent key counts as 0). A key that is not
 * a number falls back to plain three-way: the side that changed it wins,
 * and two different changes are a conflict.
 */
export function mergeCounters(b: unknown, l: unknown, r: unknown): Record<string, unknown> | Conflict {
    if (!isBag(l) || !isBag(r)) return CONFLICT
    if (b !== undefined && b !== null && !isBag(b)) return CONFLICT
    const base: Record<string, unknown> = isBag(b) ? b : {}
    const keys = new Set([...Object.keys(r), ...Object.keys(l), ...Object.keys(base)])
    const out: Record<string, unknown> = {}
    for (const key of keys) {
        // A plain assignment of this key would set the prototype instead.
        if (key === '__proto__') return CONFLICT
        const vb = base[key], vl = l[key], vr = r[key]
        if (isCounterValue(vb) && isCounterValue(vl) && isCounterValue(vr)) {
            if (vl === undefined && vr === undefined) continue
            out[key] = ((vr as number) ?? 0) + (((vl as number) ?? 0) - ((vb as number) ?? 0))
            continue
        }
        let next: unknown
        if (jsonDeepEqual(vl, vb)) next = vr
        else if (jsonDeepEqual(vr, vb) || jsonDeepEqual(vl, vr)) next = vl
        else return CONFLICT
        if (next !== undefined) out[key] = next
    }
    return out
}

/** `lastInteraction`: the later of the two, when both are numbers. */
export function maxNumber(l: unknown, r: unknown): number | Conflict {
    return isFiniteNumber(l) && isFiniteNumber(r) ? Math.max(l, r) : CONFLICT
}

/**
 * Root keys that hold an index into a root array. Merged as numbers they can
 * point at a different element than either device chose once the list
 * changed on one side, so they are merged by the element's id instead.
 */
export const INDEX_ROOT_KEYS = [
    { key: 'botPresetsId', list: 'botPresets' },
    { key: 'selectedPersona', list: 'personas' },
    { key: 'translatorPresetId', list: 'translatorPresets' },
    { key: 'loreBookPage', list: 'loreBook' },
] as const

/** Each item's `id`, or null when the list has an item without a unique non-empty string id. */
function itemIds(list: unknown): string[] | null {
    if (!Array.isArray(list)) return null
    const ids: string[] = []
    const seen = new Set<string>()
    for (const item of list) {
        const id = isBag(item) ? item.id : undefined
        if (typeof id !== 'string' || id.length === 0 || seen.has(id)) return null
        seen.add(id)
        ids.push(id)
    }
    return ids
}

const idAt = (ids: readonly string[], index: unknown) =>
    Number.isInteger(index) && (index as number) >= 0 && (index as number) < ids.length ? ids[index as number] : undefined

/**
 * The merged value of an index key, as the position of the chosen element in
 * the merged list (`rList` when the list changed remotely, else `lList`).
 * A side "chose" when it changed the index and the index now names another
 * element than B's: an index left alone while the list moved under it, or
 * re-pointed to follow its own list edit, is no choice. With no choice on
 * either side B's element is kept. Both sides choosing different elements, a
 * chosen element missing from the merged list, or a list without unique
 * ids is a conflict.
 */
export function resolveIndexKey(args: {
    bList: unknown, bIdx: unknown,
    lList: unknown, lIdx: unknown,
    rList: unknown, rIdx: unknown,
    listFromRemote: boolean,
}): number | Conflict {
    const bIds = itemIds(args.bList)
    const lIds = itemIds(args.lList)
    const rIds = itemIds(args.rList)
    if (!bIds || !lIds || !rIds) return CONFLICT
    const idB = idAt(bIds, args.bIdx)
    const idL = idAt(lIds, args.lIdx)
    const idR = idAt(rIds, args.rIdx)
    const localChose = args.lIdx !== args.bIdx && idL !== idB
    const remoteChose = args.rIdx !== args.bIdx && idR !== idB
    if (localChose && remoteChose && idL !== idR) return CONFLICT
    const chosen = localChose ? idL : remoteChose ? idR : idB
    if (chosen === undefined) return CONFLICT
    const index = (args.listFromRemote ? rIds : lIds).indexOf(chosen)
    return index < 0 ? CONFLICT : index
}

/** The id of the chat a character has open, if its chatPage names one. */
export function openChatId(char: any): string | undefined {
    const chats = char?.chats
    if (!Array.isArray(chats)) return undefined
    const id = chats[char.chatPage]?.id
    return typeof id === 'string' ? id : undefined
}

/** `i` clamped to a valid chatPage for `len` chats (0 when there are none). */
export function clampPage(i: unknown, len: number): number {
    const last = Math.max(0, len - 1)
    if (typeof i !== 'number' || !Number.isFinite(i)) return 0
    return Math.min(Math.max(0, Math.trunc(i)), last)
}
