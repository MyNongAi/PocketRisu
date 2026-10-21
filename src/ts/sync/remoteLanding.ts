// Deciding how another device's database patch lands in this page's live
// state, as a three-way merge: B is the patch baseline (what this page last
// synced), S the server's state after the patch (copyOnWritePatch.ts, which
// shares every untouched subtree with B), and live the page's own state,
// which may hold unsaved edits. remoteChangeSet says what S changed,
// localChangeSet what live changed among those entries, and planLanding
// either refuses (conflict kinds only, never values or names) or returns the
// writes. Nothing here writes: the caller applies the plan in one
// synchronous step (applyRebasedDb.ts applyRemoteChangesInPlace), so a
// refusal touches nothing and the save's rebase fallback takes over.
//
// Pure: no Svelte, no app state. What needs the app (the stub form of a
// character, normalizeJSON, placeholders, the page's busy state) is passed in.

import { hasAmbiguousCharacterIds } from '../storage/rebaseMerge'
import { CONFLICT, INDEX_ROOT_KEYS, clampPage, jsonDeepEqual, maxNumber, mergeCounters, openChatId, resolveIndexKey } from './threeWayRules'

type Db = Record<string, any>

// Root keys with rules of their own, or never synced (pluginCustomStorage),
// or impossible to write back as a plain key (__proto__).
const NOT_ROOT_KEYS = new Set(['characters', 'botPresets', 'modules', 'pluginCustomStorage', '__proto__'])

// ── What the remote changed ─────────────────────────────────────────────────

export interface RemoteCharacterChange {
    /** Keys whose presence or value differs between B and S. */
    fields: Set<string>
    /** Filled when `fields` has 'chats': chat ids in B and not in S, and the reverse. */
    removedChats: Set<string>
    addedChats: Set<string>
    /** The chat-id sequence differs (insert, delete or reorder). */
    seqChanged: boolean
}

export interface RemoteModuleChanges {
    /** The module id sequence differs. */
    structure: boolean
    added: Set<string>
    removed: Set<string>
    changed: Set<string>
}

export interface RemoteCharacterChanges {
    /** The chaId sequence differs. */
    structure: boolean
    added: Set<string>
    removed: Set<string>
    changed: Map<string, RemoteCharacterChange>
}

export interface RemoteChangeSet {
    ambiguous: false
    /** Root keys added, changed or removed (removed ones are also in `removedRoots`). */
    roots: Set<string>
    removedRoots: Set<string>
    botPresets: boolean
    /** Null when the modules did not change. */
    modules: RemoteModuleChanges | null
    /** Null when no character changed. */
    characters: RemoteCharacterChanges | null
}

/** Ids the merge pairs entries by are missing or repeated: nothing can land. */
export interface AmbiguousChangeSet {
    ambiguous: true
    reason: 'module-ids' | 'characters-shape' | 'character-ids' | 'chat-ids'
}

const ambiguous = (reason: AmbiguousChangeSet['reason']): AmbiguousChangeSet => ({ ambiguous: true, reason })

function unionKeys(a: object, b: object): string[] {
    const keys = Object.keys(a)
    const seen = new Set(keys)
    for (const key of Object.keys(b)) if (!seen.has(key)) keys.push(key)
    return keys
}

/** Keys of two objects whose presence differs or whose values are not deep-equal. */
function differingKeys(a: Record<string, unknown>, b: Record<string, unknown>): Set<string> {
    const out = new Set<string>()
    for (const key of unionKeys(a, b)) {
        const inA = Object.hasOwn(a, key)
        if (inA !== Object.hasOwn(b, key)) out.add(key)
        else if (a[key] !== b[key] && !jsonDeepEqual(a[key], b[key])) out.add(key)
    }
    return out
}

/** Ids of a list under `key`, or null when one is missing, not a string, or repeated. */
function uniqueIds(list: readonly any[], key: 'id' | 'chaId'): string[] | null {
    const ids: string[] = []
    const seen = new Set<string>()
    for (const item of list) {
        const id = item !== null && typeof item === 'object' ? item[key] : undefined
        if (typeof id !== 'string' || id.length === 0 || seen.has(id)) return null
        seen.add(id)
        ids.push(id)
    }
    return ids
}

/** A modules value as a list: absent counts as empty, anything else that is not an array is unusable. */
const moduleList = (value: unknown): any[] | null => value === undefined || value === null ? [] : Array.isArray(value) ? value : null

const sameSequence = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i])

function byKey(list: readonly any[], key: 'id' | 'chaId'): Map<string, any> {
    const map = new Map<string, any>()
    for (const item of list) map.set(item[key], item)
    return map
}

/**
 * What S changed against B. Identity first (S shares every untouched subtree
 * with B), refined with jsonDeepEqual so a replace that wrote the same value
 * (a whole /characters reorder, a no-op primitive replace) counts as nothing.
 */
export function remoteChangeSet(B: Db, S: Db): RemoteChangeSet | AmbiguousChangeSet {
    const roots = new Set<string>()
    const removedRoots = new Set<string>()
    for (const key of unionKeys(B, S)) {
        if (NOT_ROOT_KEYS.has(key)) continue
        const inB = Object.hasOwn(B, key)
        if (inB !== Object.hasOwn(S, key)) {
            roots.add(key)
            if (inB) removedRoots.add(key)
        } else if (S[key] !== B[key] && !jsonDeepEqual(S[key], B[key])) {
            roots.add(key)
        }
    }

    const botPresets = S.botPresets !== B.botPresets && !jsonDeepEqual(S.botPresets, B.botPresets)

    let modules: RemoteModuleChanges | null = null
    if (S.modules !== B.modules) {
        const bList = moduleList(B.modules)
        const sList = moduleList(S.modules)
        const bIds = bList && uniqueIds(bList, 'id')
        const sIds = sList && uniqueIds(sList, 'id')
        if (!bIds || !sIds) return ambiguous('module-ids')
        const bById = byKey(bList, 'id')
        const sById = byKey(sList, 'id')
        const changed = new Set<string>()
        for (const id of sIds) {
            const bm = bById.get(id)
            const sm = sById.get(id)
            if (bm !== undefined && sm !== bm && !jsonDeepEqual(sm, bm)) changed.add(id)
        }
        const structure = !sameSequence(bIds, sIds)
        if (structure || changed.size > 0) {
            modules = {
                structure,
                added: new Set(sIds.filter((id) => !bById.has(id))),
                removed: new Set(bIds.filter((id) => !sById.has(id))),
                changed,
            }
        }
    }

    let characters: RemoteCharacterChanges | null = null
    if (S.characters !== B.characters) {
        if (!Array.isArray(B.characters) || !Array.isArray(S.characters)) return ambiguous('characters-shape')
        if (hasAmbiguousCharacterIds(B.characters) || hasAmbiguousCharacterIds(S.characters)) return ambiguous('character-ids')
        const bById = byKey(B.characters, 'chaId')
        const sById = byKey(S.characters, 'chaId')
        const changed = new Map<string, RemoteCharacterChange>()
        for (const [id, sc] of sById) {
            const bc = bById.get(id)
            if (bc === undefined || bc === sc) continue
            const fields = differingKeys(bc, sc)
            if (fields.size === 0) continue
            const change: RemoteCharacterChange = { fields, removedChats: new Set(), addedChats: new Set(), seqChanged: false }
            if (fields.has('chats')) {
                // The landing pairs chats by id; both sides need usable ones.
                const bChats = Array.isArray(bc.chats) ? uniqueIds(bc.chats, 'id') : null
                const sChats = Array.isArray(sc.chats) ? uniqueIds(sc.chats, 'id') : null
                if (!bChats || !sChats) return ambiguous('chat-ids')
                const bSet = new Set(bChats)
                const sSet = new Set(sChats)
                for (const chatId of bChats) if (!sSet.has(chatId)) change.removedChats.add(chatId)
                for (const chatId of sChats) if (!bSet.has(chatId)) change.addedChats.add(chatId)
                change.seqChanged = !sameSequence(bChats, sChats)
            }
            changed.set(id, change)
        }
        const bSeq = B.characters.map((c: any) => c.chaId as string)
        const sSeq = S.characters.map((c: any) => c.chaId as string)
        const structure = !sameSequence(bSeq, sSeq)
        if (structure || changed.size > 0) {
            characters = {
                structure,
                added: new Set(sSeq.filter((id) => !bById.has(id))),
                removed: new Set(bSeq.filter((id) => !sById.has(id))),
                changed,
            }
        }
    }

    return { ambiguous: false, roots, removedRoots, botPresets, modules, characters }
}

// ── What this page changed, among the entries the remote changed ────────────

/** The patcher's per-entry baseline JSON (RisuSavePatcher), for a cheap "unchanged" check. */
export interface PatcherBaselineJson {
    baselineRootKeyJson(key: string): string | undefined
    baselineCharacterJson(chaId: string): string | undefined
    baselineModuleJson(id: string): string | undefined
}

/**
 * One live entry against B. `present` follows the save (an own key whose
 * normalized value is not undefined); `value` is that normalized value, set
 * when the entry changed and is present.
 */
export interface LocalEntry {
    changed: boolean
    present: boolean
    value?: unknown
}

export interface LocalCharacter {
    present: boolean
    /** F_L: keys whose stub view differs from B's, chatPage excluded (see `moved`). */
    fields: Set<string>
    /** The normalized stub view, when it had to be computed (F_L non-empty, or not in B). */
    stub: Record<string, any> | null
    /** The user opened another chat here since the last sync (a hold does not count). */
    moved: boolean
}

export interface LocalChangeSet {
    /** Every root key the plan reads: R's, plus the partner of each index key or list R changed. */
    roots: Map<string, LocalEntry>
    /** Null when not needed (R changed neither botPresets nor botPresetsId). */
    botPresets: LocalEntry | null
    /** Null when R did not change the modules. Entries: R's changed, removed and added ids. */
    modules: { ambiguous: boolean, structure: boolean, ids: string[], entries: Map<string, LocalEntry> } | null
    /** Null when R changed no character. Entries: R's changed, removed and added chaIds. */
    characters: { ambiguous: boolean, structure: boolean, entries: Map<string, LocalCharacter> } | null
}

const UNCHANGED_PRESENT: LocalEntry = Object.freeze({ changed: false, present: true }) as LocalEntry

function tryStringify(value: unknown): string | undefined {
    try { return JSON.stringify(value) } catch { return undefined }
}

/**
 * Which of the entries R touched this page changed since B. Runs inside the
 * synchronous write section (no await between this and the write), so what
 * it sees is what the write overwrites. `characterWithStubs` is the save's
 * stub form (storage/risuSave.ts) and `normalize` its normalizeJSON, passed
 * in to keep this module free of the app's module graph.
 */
export function localChangeSet(args: {
    B: Db
    live: Db
    R: RemoteChangeSet
    patcher: PatcherBaselineJson
    normalize: (value: unknown) => any
    characterWithStubs: (char: any) => any
    holds: ReadonlyMap<string, string>
}): LocalChangeSet {
    const { B, live, R, patcher, normalize, characterWithStubs, holds } = args

    const rootKeys = new Set(R.roots)
    for (const { key, list } of INDEX_ROOT_KEYS) {
        const listChanged = list === 'botPresets' ? R.botPresets : R.roots.has(list)
        if (listChanged) rootKeys.add(key)
        if (R.roots.has(key) && list !== 'botPresets') rootKeys.add(list)
    }
    const roots = new Map<string, LocalEntry>()
    for (const key of rootKeys) {
        const inB = Object.hasOwn(B, key)
        const inLive = Object.hasOwn(live, key)
        if (inB && inLive) {
            const json = tryStringify(live[key])
            if (json !== undefined && json === patcher.baselineRootKeyJson(key)) {
                roots.set(key, UNCHANGED_PRESENT)
                continue
            }
        }
        const value = inLive ? normalize(live[key]) : undefined
        const present = value !== undefined
        if (present !== inB) roots.set(key, { changed: true, present, value })
        else if (!present) roots.set(key, { changed: false, present: false })
        else if (jsonDeepEqual(value, B[key])) roots.set(key, UNCHANGED_PRESENT)
        else roots.set(key, { changed: true, present: true, value })
    }

    let botPresets: LocalEntry | null = null
    if (R.botPresets || R.roots.has('botPresetsId')) {
        // The save diffs presets as `normalizeJSON(botPresets) ?? []`.
        const value = normalize(live.botPresets) ?? []
        botPresets = jsonDeepEqual(value, B.botPresets ?? []) ? UNCHANGED_PRESENT : { changed: true, present: true, value }
    }

    let modules: LocalChangeSet['modules'] = null
    if (R.modules) {
        const liveList = moduleList(live.modules)
        const ids = liveList && uniqueIds(liveList, 'id')
        if (!ids) {
            modules = { ambiguous: true, structure: true, ids: [], entries: new Map() }
        } else {
            const bList = moduleList(B.modules) ?? []
            const bById = byKey(bList, 'id')
            const liveById = byKey(liveList, 'id')
            const entries = new Map<string, LocalEntry>()
            for (const id of [...R.modules.changed, ...R.modules.removed, ...R.modules.added]) {
                const mine = liveById.get(id)
                const theirs = bById.get(id)
                if (mine === undefined) {
                    entries.set(id, { changed: theirs !== undefined, present: false })
                    continue
                }
                if (theirs !== undefined) {
                    const json = tryStringify(mine)
                    if (json !== undefined && json === patcher.baselineModuleJson(id)) {
                        entries.set(id, UNCHANGED_PRESENT)
                        continue
                    }
                }
                const value = normalize(mine)
                entries.set(id, theirs !== undefined && jsonDeepEqual(value, theirs) ? UNCHANGED_PRESENT : { changed: true, present: true, value })
            }
            const bIds = bList.map((m: any) => m.id as string)
            modules = { ambiguous: false, structure: !sameSequence(ids, bIds), ids, entries }
        }
    }

    let characters: LocalChangeSet['characters'] = null
    if (R.characters) {
        const liveList: any[] | null = Array.isArray(live.characters) ? live.characters : null
        if (!liveList || hasAmbiguousCharacterIds(liveList)) {
            characters = { ambiguous: true, structure: true, entries: new Map() }
        } else {
            const bById = byKey(B.characters, 'chaId')
            const liveById = byKey(liveList, 'chaId')
            const entries = new Map<string, LocalCharacter>()
            for (const id of [...R.characters.changed.keys(), ...R.characters.removed, ...R.characters.added]) {
                const mine = liveById.get(id)
                const theirs = bById.get(id)
                if (mine === undefined) {
                    entries.set(id, { present: false, fields: new Set(), stub: null, moved: false })
                    continue
                }
                const stubbed = characterWithStubs(mine)
                if (theirs === undefined) {
                    entries.set(id, { present: true, fields: new Set(), stub: normalize(stubbed), moved: false })
                    continue
                }
                const openHere = openChatId(mine)
                const moved = openHere !== openChatId(theirs) && holds.get(id) !== openHere
                const json = tryStringify(stubbed)
                if (json !== undefined && json === patcher.baselineCharacterJson(id)) {
                    entries.set(id, { present: true, fields: new Set(), stub: null, moved })
                    continue
                }
                const stub = normalize(stubbed)
                const fields = differingKeys(stub, theirs)
                fields.delete('chatPage')
                entries.set(id, { present: true, fields, stub, moved })
            }
            const liveSeq = liveList.map((c: any) => c.chaId as string)
            const bSeq = B.characters.map((c: any) => c.chaId as string)
            characters = { ambiguous: false, structure: !sameSequence(liveSeq, bSeq), entries }
        }
    }

    return { roots, botPresets, modules, characters }
}

// ── The landing plan ────────────────────────────────────────────────────────

/** What planLanding reads from the page, synchronously. */
export interface LandingPageView {
    selectedChaId(): string | null | undefined
    /** Chats drawn in the split pane beside the selection. */
    splitPaneChats(): readonly ChatRef[]
    /** Streaming, generating, rerolling, hydrating, or holding unsaved edits. */
    isChatBusy(chaId: string, chatId: string): boolean
    isCharacterGenerating(chaId: string): boolean
}

export interface ChatRef {
    chaId: string
    chatId: string
}

export interface WritePlan {
    ok: true
    /** Root values to bring live to (reconcileInto per key); includes botPresets/modules when written. */
    roots: Record<string, unknown>
    deleteRoots: string[]
    /** The full merged character order, or null when no character is written. Untouched entries ARE the live objects. */
    characters: any[] | null
    /** Loaded chats whose catalog the write updates, minus busy ones: their dirty tracking is suppressed for the write. */
    suppress: ChatRef[]
    /** The character order changed, or a written character's chat-id sequence did. */
    structural: boolean
    /** The selected character was removed. */
    deselect: boolean
    /** chaId -> the chat this page keeps open while the server points elsewhere; null clears a hold. */
    holdUpdates: Map<string, string | null>
    /** The selected character's open chat was removed elsewhere (the page shows a neighbour now). */
    removedOpenChat: ChatRef | null
    languageChanged: boolean
    /** Chat ids present in S for the changed and added characters. */
    knownChats: Map<string, string[]>
    removedCharacters: string[]
}

export interface LandingRefused {
    ok: false
    /** Kind names only (`root:statics`, `char-field:desc`): never values or names. */
    conflicts: string[]
}

const isLoadedChat = (chat: any) =>
    chat !== null && typeof chat === 'object' && !chat._placeholder && !chat._stub && Array.isArray(chat.message)

function chatIdsOf(chats: unknown): string[] {
    return Array.isArray(chats) ? chats.map((chat: any) => chat?.id) : []
}

/** Equal stub views, ignoring chatPage (the chatPage rule decides that one). */
function sameStubView(stub: Record<string, any> | null, server: Record<string, any>): boolean {
    if (!stub) return false
    const keys = differingKeys(stub, server)
    keys.delete('chatPage')
    return keys.size === 0
}

export type PlanLandingArgs = {
    B: Db
    S: Db
    R: RemoteChangeSet
    L: LocalChangeSet
    live: Db
    page: LandingPageView
    holds: ReadonlyMap<string, string>
    clone: <T>(value: T) => T
    toPlaceholders: (chats: any[]) => any[]
}

/** The plan as it is built; `conflicts` collects every refusal kind. */
type Draft = Omit<WritePlan, 'ok' | 'languageChanged'> & { conflicts: Set<string> }

/**
 * The writes that land S in live, or the conflict kinds that refuse it.
 * Reads only; `clone` copies every value taken from S (which shares objects
 * with the baseline), and `toPlaceholders` is chatStorage's
 * convertStubsToPlaceholders. `L` must come from localChangeSet on the same
 * B, live and R, with no await in between.
 */
export function planLanding(args: PlanLandingArgs): WritePlan | LandingRefused {
    const draft: Draft = {
        conflicts: new Set(),
        roots: {},
        deleteRoots: [],
        characters: null,
        suppress: [],
        structural: false,
        deselect: false,
        holdUpdates: new Map(),
        removedOpenChat: null,
        knownChats: new Map(),
        removedCharacters: [],
    }
    planRoots(args, draft)
    if (args.R.modules) planModules(args, draft, args.R.modules)
    if (args.R.characters) planCharacters(args, draft, args.R.characters)
    checkArchiveInvariant(args, draft)

    const { conflicts, ...plan } = draft
    if (conflicts.size > 0) return { ok: false, conflicts: [...conflicts] }
    return {
        ok: true,
        ...plan,
        languageChanged: Object.hasOwn(plan.roots, 'language') || plan.deleteRoots.includes('language'),
    }
}

function localRoot({ L }: PlanLandingArgs, { conflicts }: Draft, key: string): LocalEntry | undefined {
    const entry = L.roots.get(key)
    if (!entry) conflicts.add(`root-unchecked:${key}`)
    return entry
}

function planRoots(args: PlanLandingArgs, draft: Draft) {
    const { B, S, R, L, live, clone } = args
    const { conflicts, roots, deleteRoots } = draft

    // An index key set on one side while its list changed on the other
    // follows the chosen element's id; it then skips the plain rule below.
    // Both sides setting it over an unchanged list is the plain rule's case.
    const settled = new Set<string>()
    for (const { key, list } of INDEX_ROOT_KEYS) {
        const keyR = R.roots.has(key)
        const listR = list === 'botPresets' ? R.botPresets : R.roots.has(list)
        if (!keyR && !listR) continue
        const keyEntry = localRoot(args, draft, key)
        const listEntry = list === 'botPresets' ? L.botPresets : localRoot(args, draft, list)
        if (!listEntry && list === 'botPresets') conflicts.add('botPresets-unchecked')
        if (!keyEntry || !listEntry) continue
        const keyL = keyEntry.changed
        const listL = listEntry.changed
        if (!((keyL && listR) || (keyR && listL))) continue
        settled.add(key)
        // Both lists changed: the list's own rule decides, and equal lists stay live.
        if (listR && listL && !(listEntry.present && jsonDeepEqual(listEntry.value, S[list]))) continue
        const index = resolveIndexKey({
            bList: B[list], bIdx: B[key],
            lList: live[list], lIdx: live[key],
            rList: S[list], rIdx: S[key],
            listFromRemote: listR && !listL,
        })
        if (index === CONFLICT) conflicts.add(`index:${key}`)
        else if (index !== live[key]) roots[key] = index
    }

    for (const key of R.roots) {
        if (settled.has(key)) continue
        const entry = localRoot(args, draft, key)
        if (!entry) continue
        const removed = R.removedRoots.has(key)
        if (!entry.changed) {
            if (removed) deleteRoots.push(key)
            else roots[key] = clone(S[key])
            continue
        }
        if (removed) {
            // Removed here too: nothing to do.
            if (entry.present) conflicts.add(`root:${key}`)
            continue
        }
        if (entry.present && jsonDeepEqual(entry.value, S[key])) continue
        if (entry.present && key === 'statics') {
            const merged = mergeCounters(B[key], entry.value, S[key])
            if (merged === CONFLICT) conflicts.add(`root:${key}`)
            else roots[key] = clone(merged)
            continue
        }
        conflicts.add(`root:${key}`)
    }

    if (R.botPresets) {
        const entry = L.botPresets
        if (!entry) conflicts.add('botPresets-unchecked')
        else if (!Object.hasOwn(S, 'botPresets')) conflicts.add('botPresets')
        else if (!entry.changed) roots.botPresets = clone(S.botPresets)
        else if (!jsonDeepEqual(entry.value, S.botPresets)) conflicts.add('botPresets')
    }
}

function planModules(args: PlanLandingArgs, draft: Draft, remote: RemoteModuleChanges) {
    const { S, L, live, clone } = args
    const { conflicts } = draft
    const local = L.modules
    if (!local) { conflicts.add('modules-unchecked'); return }
    if (local.ambiguous) { conflicts.add('ambiguous-live-modules'); return }
    const sList = moduleList(S.modules) ?? []
    const sIds = sList.map((m: any) => m.id as string)
    if (remote.structure && local.structure && !sameSequence(local.ids, sIds)) {
        conflicts.add('modules-structure')
        return
    }
    const sById = byKey(sList, 'id')
    const liveById = byKey(moduleList(live.modules) ?? [], 'id')
    // Changed (or removed, or added) on both sides: fine only when the results are equal.
    const sameOnBoth = new Set<string>()
    for (const id of [...remote.changed, ...remote.removed, ...remote.added]) {
        const entry = local.entries.get(id)
        if (!entry) { conflicts.add('modules-unchecked'); return }
        if (!entry.changed) continue
        const theirs = sById.get(id)
        const equal = entry.present ? theirs !== undefined && jsonDeepEqual(entry.value, theirs) : theirs === undefined
        if (equal) sameOnBoth.add(id)
        else conflicts.add('module')
    }
    const order = remote.structure ? sIds : local.ids
    const merged: any[] = []
    for (const id of order) {
        const fromRemote = (remote.changed.has(id) || remote.added.has(id)) && !sameOnBoth.has(id)
        const value = fromRemote ? clone(sById.get(id)) : liveById.get(id)
        if (value === undefined) { conflicts.add('module'); return }
        merged.push(value)
    }
    draft.roots.modules = merged
}

function planCharacters(args: PlanLandingArgs, draft: Draft, remote: RemoteCharacterChanges) {
    const { S, L, live, page, holds, clone, toPlaceholders } = args
    const { conflicts, holdUpdates, knownChats } = draft
    const local = L.characters
    if (!local) { conflicts.add('characters-unchecked'); return }
    if (local.ambiguous) { conflicts.add('ambiguous-live-characters'); return }
    const liveList: any[] = live.characters
    const sList: any[] = S.characters
    const liveSeq = liveList.map((c) => c.chaId as string)
    const sSeq = sList.map((c) => c.chaId as string)
    if (remote.structure && local.structure && !sameSequence(liveSeq, sSeq)) {
        conflicts.add('char-structure')
        return
    }
    const liveById = byKey(liveList, 'chaId')
    const sById = byKey(sList, 'chaId')
    const selected = page.selectedChaId()
    const split = page.splitPaneChats()
    const replacements = new Map<string, any>()
    const entryOf = (id: string) => {
        const entry = local.entries.get(id)
        if (!entry) conflicts.add('characters-unchecked')
        return entry
    }

    for (const id of remote.removed) {
        const mine = liveById.get(id)
        if (mine === undefined) continue // removed here as well
        const entry = entryOf(id)
        if (!entry) continue
        if (entry.fields.size > 0) conflicts.add('char-removed-edited')
        if (chatIdsOf(mine.chats).some((chatId) => typeof chatId === 'string' && page.isChatBusy(id, chatId))) conflicts.add('char-removed-busy')
        if (page.isCharacterGenerating(id)) conflicts.add('char-removed-generating')
        if (split.some((shown) => shown.chaId === id)) conflicts.add('char-removed-split')
        draft.removedCharacters.push(id)
        if (id === selected) draft.deselect = true
        if (holds.has(id)) holdUpdates.set(id, null)
    }

    for (const id of remote.added) {
        const theirs = sById.get(id)
        if (liveById.has(id)) {
            // Added here too (the same structural change on both sides).
            if (!sameStubView(entryOf(id)?.stub ?? null, theirs)) conflicts.add('char-added-differs')
            continue
        }
        const fresh = clone(theirs)
        fresh.chats = toPlaceholders(Array.isArray(fresh.chats) ? fresh.chats : [])
        replacements.set(id, fresh)
        knownChats.set(id, chatIdsOf(theirs.chats))
    }

    for (const [id, change] of remote.changed) {
        const mine = liveById.get(id)
        const entry = entryOf(id)
        if (!entry) continue
        if (mine === undefined) { conflicts.add('char-removed-locally'); continue }
        const theirs = sById.get(id)
        knownChats.set(id, chatIdsOf(theirs.chats))
        // Every field to keep is listed: the write deletes keys a source lacks.
        const source: Record<string, any> = { ...mine }
        let touched = false
        let chatsFromRemote = false
        for (const field of change.fields) {
            if (field === 'chatPage') continue
            // A plain assignment of this key would set the prototype instead.
            if (field === '__proto__') { conflicts.add('char-field:__proto__'); continue }
            const remotePresent = Object.hasOwn(theirs, field)
            if (!entry.fields.has(field)) {
                if (field === 'chats') { chatsFromRemote = true; continue }
                if (remotePresent) source[field] = clone(theirs[field])
                else delete source[field]
                touched = true
                continue
            }
            const stub = entry.stub ?? {}
            const localPresent = Object.hasOwn(stub, field)
            if (localPresent === remotePresent && (!localPresent || jsonDeepEqual(stub[field], theirs[field]))) continue
            if (field === 'lastInteraction') {
                const later = maxNumber(stub[field], theirs[field])
                if (later === CONFLICT) conflicts.add('char-field:lastInteraction')
                else if (later !== mine[field]) { source[field] = later; touched = true }
                continue
            }
            // Phase 1: a chat list changed on both sides goes to the rebase.
            conflicts.add(field === 'chats' ? 'char-chats' : `char-field:${field}`)
        }

        if (chatsFromRemote) {
            const remoteChats: any[] = theirs.chats
            for (const chatId of change.removedChats) {
                if (page.isChatBusy(id, chatId)) conflicts.add('chat-removed-busy')
                if (split.some((shown) => shown.chaId === id && shown.chatId === chatId)) conflicts.add('chat-removed-split')
            }
            if (id === selected && remoteChats.length === 0 && chatIdsOf(mine.chats).length > 0) conflicts.add('chat-removed-last')
            // Placeholders from S; the write keeps each loaded body by id.
            source.chats = toPlaceholders(clone(remoteChats))
            touched = true
            if (!sameSequence(chatIdsOf(mine.chats), chatIdsOf(source.chats))) draft.structural = true
            if (!page.isCharacterGenerating(id)) {
                const kept = new Set(chatIdsOf(remoteChats))
                for (const chat of Array.isArray(mine.chats) ? mine.chats : []) {
                    if (isLoadedChat(chat) && kept.has(chat.id) && !page.isChatBusy(id, chat.id)) draft.suppress.push({ chaId: id, chatId: chat.id })
                }
            }
        }

        if (chatsFromRemote || change.fields.has('chatPage')) {
            // Never a conflict: the selected character (or one the user moved
            // here) keeps its open chat by id, the others follow the server.
            const chats: any[] = chatsFromRemote ? source.chats : (Array.isArray(mine.chats) ? mine.chats : [])
            const idHere = openChatId(mine)
            const idServer = openChatId(theirs)
            const keepLocal = id === selected || entry.moved
            const wanted = keepLocal ? idHere : idServer
            let chatPage = wanted === undefined ? -1 : chats.findIndex((chat) => chat?.id === wanted)
            if (chatPage < 0) {
                // Only a clean chat can be gone here: removing a busy one is a conflict above.
                chatPage = clampPage(keepLocal ? mine.chatPage : theirs.chatPage, chats.length)
                if (id === selected && wanted !== undefined) draft.removedOpenChat = { chaId: id, chatId: wanted }
            }
            if (chatPage !== mine.chatPage) { source.chatPage = chatPage; touched = true }
            const openId = chats[chatPage]?.id
            if (keepLocal && !entry.moved && typeof openId === 'string' && openId !== idServer) {
                if (holds.get(id) !== openId) holdUpdates.set(id, openId)
            } else if (holds.has(id)) {
                holdUpdates.set(id, null)
            }
        }

        if (touched) replacements.set(id, source)
    }

    const order = remote.structure ? sSeq : liveSeq
    const merged: any[] = []
    for (const id of order) {
        const value = replacements.get(id) ?? liveById.get(id)
        if (value === undefined) { conflicts.add('char-removed-locally'); return }
        merged.push(value)
    }
    if (!sameSequence(order, liveSeq)) draft.structural = true
    if (replacements.size > 0 || draft.structural) draft.characters = merged
}

/** A chaId both active and deactivated breaks every later save (the server rejects it). */
function checkArchiveInvariant({ live }: PlanLandingArgs, draft: Draft) {
    const key = 'nodeOnlyArchivedCharacters'
    const written = Object.hasOwn(draft.roots, key)
    const deleted = draft.deleteRoots.includes(key)
    if (!draft.characters && !written && !deleted) return
    const archived = written ? draft.roots[key] : deleted ? [] : live[key]
    const archivedIds = new Set<unknown>((Array.isArray(archived) ? archived : []).map((stub: any) => stub?.chaId))
    archivedIds.delete(undefined)
    if (archivedIds.size === 0) return
    const characters: any[] = draft.characters ?? (Array.isArray(live.characters) ? live.characters : [])
    if (characters.some((character) => archivedIds.has(character?.chaId))) draft.conflicts.add('archive-invariant')
}
