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

// ── Phase 2: the rebase fallback (storage/rebaseMerge.ts) ─────────────────
// Unlike the landing, the rebase cannot refuse: a value both sides changed
// takes this page's (today's rule) and the caller logs the kind.

const sameSequence = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i])

/**
 * `primary`, with each id only `secondary` has inserted right after the
 * nearest id before it in `secondary` that is already placed (at the front
 * when there is none).
 */
export function weaveIds(primary: readonly string[], secondary: readonly string[]): string[] {
    const out = [...primary]
    const placed = new Set(out)
    let at = -1
    for (const id of secondary) {
        if (placed.has(id)) {
            at = out.indexOf(id)
            continue
        }
        out.splice(at + 1, 0, id)
        placed.add(id)
        at += 1
    }
    return out
}

/**
 * The order of two edits of the id list `b`: the side that reordered the ids
 * all three lists keep sets it, and the other side's additions are woven in.
 * Null when both reordered them, differently.
 */
export function mergeIdSequence(b: readonly string[], l: readonly string[], r: readonly string[]): string[] | null {
    const inL = new Set(l)
    const inR = new Set(r)
    const kept = new Set(b.filter((id) => inL.has(id) && inR.has(id)))
    const order = (list: readonly string[]) => list.filter((id) => kept.has(id))
    const bKept = order(b), lKept = order(l), rKept = order(r)
    const localMoved = !sameSequence(lKept, bKept)
    const remoteMoved = !sameSequence(rKept, bKept)
    if (localMoved && remoteMoved && !sameSequence(lKept, rKept)) return null
    return localMoved ? weaveIds(l, r) : weaveIds(r, l)
}

// The catalog fields a chat stub carries besides its id (chatToStub,
// storage/chatStorage.ts).
const CHAT_CATALOG_FIELDS = ['name', 'lastDate', 'folderId', 'modules'] as const

const sameField = (x: any, y: any, field: string) => {
    const inX = x !== null && typeof x === 'object' && Object.hasOwn(x, field)
    const inY = y !== null && typeof y === 'object' && Object.hasOwn(y, field)
    return inX === inY && (!inX || jsonDeepEqual(x[field], y[field]))
}

export interface ChatCatalogArgs {
    /** The baseline's chat stubs. */
    b: readonly any[]
    /** This page's chats (bodies or placeholders), the caller's own copies: entries are reused. */
    l: readonly any[]
    /** The server's chat stubs, the caller's own copies. */
    r: readonly any[]
    /** Generating, being written, unsaved or shown in a pane here. */
    isBusy: (chatId: string) => boolean
    /** A local chat in the baseline's form (normalized stub). */
    stubView: (chat: any) => any
    normalize: (value: unknown) => any
    /** A server stub as a runtime chat (a placeholder). */
    toPlaceholder: (stub: any) => any
}

/**
 * A character's chat list merged three ways: a chat stays unless one side
 * removed it and the other left it alone, either side's new chats are kept,
 * and catalog fields changed on both sides take this page's value (lastDate
 * the later one). Null when a list has a chat without a unique id; the
 * caller then keeps today's whole-character overlay.
 */
export function mergeChatCatalog(args: ChatCatalogArgs): { chats: any[], conflicts: string[] } | null {
    const bIds = itemIds(args.b), lIds = itemIds(args.l), rIds = itemIds(args.r)
    if (!bIds || !lIds || !rIds) return null
    const conflicts: string[] = []
    const bById = new Map(args.b.map((chat) => [chat.id as string, chat]))
    const lById = new Map(args.l.map((chat) => [chat.id as string, chat]))
    const rById = new Map(args.r.map((chat) => [chat.id as string, chat]))
    const views = new Map<string, any>()
    const localView = (id: string) => {
        if (!views.has(id)) views.set(id, args.stubView(lById.get(id)))
        return views.get(id)
    }
    const serverView = (id: string) => args.normalize(rById.get(id))
    const loaded = (chat: any) => chat?._placeholder !== true

    const keep = new Set<string>()
    for (const id of bIds) {
        const inL = lById.has(id), inR = rById.has(id)
        if (inL && inR) keep.add(id)
        else if (inL) {
            // Removed on the server: dropped unless changed or in use here,
            // and then kept only with a body to save again.
            if (args.isBusy(id) || !jsonDeepEqual(localView(id), bById.get(id))) {
                if (loaded(lById.get(id))) keep.add(id)
                conflicts.push('chat-removed-edited')
            }
        } else if (inR && !jsonDeepEqual(serverView(id), bById.get(id))) {
            // Removed here, changed on the server: its body is still there.
            keep.add(id)
            conflicts.push('chat-edited-removed')
        }
    }
    for (const id of lIds) if (!bById.has(id)) keep.add(id)
    for (const id of rIds) if (!bById.has(id)) keep.add(id)

    let order = mergeIdSequence(bIds, lIds, rIds)
    if (!order) {
        conflicts.push('chat-order')
        order = weaveIds(lIds, rIds)
    }

    const chats: any[] = []
    for (const id of order) {
        if (!keep.has(id)) continue
        const mine = lById.get(id)
        const theirs = rById.get(id)
        if (mine === undefined) {
            chats.push(args.toPlaceholder(theirs))
            continue
        }
        if (theirs !== undefined) {
            const base = bById.get(id)
            const lv = localView(id)
            const rv = serverView(id)
            for (const field of CHAT_CATALOG_FIELDS) {
                if (sameField(lv, rv, field)) continue
                if (sameField(lv, base, field)) {
                    // Unchanged here: the server's value.
                    if (Object.hasOwn(theirs, field)) mine[field] = theirs[field]
                    else delete mine[field]
                } else if (!sameField(rv, base, field)) {
                    if (field === 'lastDate') {
                        const later = maxNumber(mine[field], theirs[field])
                        if (later !== CONFLICT) { mine[field] = later; continue }
                    }
                    conflicts.push(`chat-field:${field}`)
                }
            }
        }
        chats.push(mine)
    }
    return { chats, conflicts }
}

export interface CharacterMergeArgs {
    /** The baseline's character (stub chats, normalized). */
    base: any
    /** This page's character, the caller's own copy. */
    local: any
    /** `local` in the baseline's form (normalized, chats as stubs). */
    localView: any
    /** The server's character, the caller's own copy. */
    server: any
    /** The character is selected here: it keeps the chat it shows. */
    selected: boolean
    /** The chat this page holds open while the server points elsewhere. */
    hold: string | undefined
    isChatBusy: (chatId: string) => boolean
    chatStubView: (chat: any) => any
    normalize: (value: unknown) => any
    toPlaceholder: (stub: any) => any
}

/**
 * A character merged field by field: a field only one side changed takes
 * that side's value, lastInteraction the later one, and one both changed
 * this page's (the caller logs the kind). Chats go through mergeChatCatalog
 * and chatPage follows the open chat by id. Null when the chats cannot be
 * merged by id.
 */
export function mergeCharacter3(args: CharacterMergeArgs): {
    character: any
    conflicts: string[]
    /** Hold this chat open (the server's chatPage points elsewhere); null for no hold. */
    hold: string | null
    /** The selected character's open chat is gone: the page shows a neighbour. */
    removedOpenChat: boolean
} | null {
    const { base, local, localView, server } = args
    const catalog = mergeChatCatalog({
        b: Array.isArray(base?.chats) ? base.chats : [],
        l: Array.isArray(local?.chats) ? local.chats : [],
        r: Array.isArray(server?.chats) ? server.chats : [],
        isBusy: args.isChatBusy,
        stubView: args.chatStubView,
        normalize: args.normalize,
        toPlaceholder: args.toPlaceholder,
    })
    if (!catalog) return null
    const conflicts = [...catalog.conflicts]
    const out: Record<string, any> = {}
    const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(localView ?? {}), ...Object.keys(server ?? {})])
    for (const key of keys) {
        if (key === 'chats' || key === 'chatPage') continue
        // A plain assignment of this key would set the prototype instead.
        if (key === '__proto__') { conflicts.push('char-field:__proto__'); continue }
        const serverView = Object.hasOwn(server, key) ? { [key]: args.normalize(server[key]) } : {}
        let fromLocal: boolean
        if (sameField(localView, base, key)) fromLocal = false
        else if (sameField(serverView, base, key) || sameField(localView, serverView, key)) fromLocal = true
        else {
            if (key === 'lastInteraction') {
                const later = maxNumber(local[key], server[key])
                if (later !== CONFLICT) { out[key] = later; continue }
            }
            conflicts.push(`char-field:${key}`)
            fromLocal = true
        }
        const source = fromLocal ? local : server
        if (Object.hasOwn(source, key) && source[key] !== undefined) out[key] = source[key]
    }
    out.chats = catalog.chats

    const idHere = openChatId(local)
    const idServer = openChatId(server)
    const moved = idHere !== openChatId(base) && args.hold !== idHere
    const keepLocal = args.selected || moved
    const wanted = keepLocal ? idHere : idServer
    let chatPage = wanted === undefined ? -1 : out.chats.findIndex((chat: any) => chat?.id === wanted)
    const removedOpenChat = args.selected && wanted !== undefined && chatPage < 0
    if (chatPage < 0) chatPage = clampPage(keepLocal ? local.chatPage : server.chatPage, out.chats.length)
    out.chatPage = chatPage
    const openId = out.chats[chatPage]?.id
    const hold = keepLocal && !moved && typeof openId === 'string' && openId !== idServer ? openId : null
    return { character: out, conflicts, hold, removedOpenChat }
}
