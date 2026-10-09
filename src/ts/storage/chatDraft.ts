import { forageStorage } from "../globalApi.svelte"
import { isStaleBuild } from "./buildFence"

// Per-chat composer drafts. The unsent text in the message input is stored
// outside the chat content so that unmounting the chat view (e.g. opening
// Settings) does not lose it. Each draft is its own forage key (a single row in
// the server SQLite `kv` table), keyed by character + chat id, so it:
//   - syncs across devices (shared server backend),
//   - is isolated from the chat body (a draft write never re-uploads the chat),
//   - never touches the Chat schema (no data-compat concerns).
//
// Writes are debounced (each is a network round-trip) and flushed immediately on
// blur / chat switch / unmount / page hide. All writes run through one serialized
// queue so a delayed save can never land after a later remove (which would
// resurrect a sent draft). Drafts of deleted chats are NOT cleaned per-delete;
// sweepOrphanDrafts() clears them in a single boot pass instead.

export interface ChatDraft {
    /** Raw message input. */
    m: string
    /** Translate-input buffer (input-translation feature). */
    t: string
}

const PREFIX = 'drafts/'
const DEBOUNCE_MS = 800

export function chatDraftKey(chaId: string, chatId: string): string {
    return `${PREFIX}${chaId}/${chatId}`
}

// In-memory index of keys known to have a draft. Loaded once per session via a
// single prefix list, so opening a chat without a draft costs no server round
// trip. Stale only w.r.t. drafts another device creates mid-session (picked up
// on next load) — acceptable for drafts.
let draftKeys: Set<string> | null = null
let indexLoading: Promise<void> | null = null

async function ensureIndex(): Promise<void> {
    if (draftKeys) return
    if (!indexLoading) {
        indexLoading = forageStorage.keys(PREFIX)
            .then((keys) => { draftKeys = new Set(keys) })
            .catch(() => { draftKeys = new Set() })
    }
    await indexLoading
}

// Keys for which a server write was attempted. The server may hold the value
// even if the response was lost (so the key never made it into `draftKeys`); a
// later remove must still fire for these, or a sent draft could reappear next
// session. Keys never written stay out, so no needless remove round trips.
const maybeSaved = new Set<string>()

// Serialized write queue. Every persist runs after the previous one settles, so
// operations on the same key keep their submission order. Errors are swallowed:
// a failed draft write must never disrupt chatting.
let writeChain: Promise<void> = Promise.resolve()
function enqueue(op: () => Promise<void>): void {
    // A tab on an outdated build no longer writes (buildFence.ts); its text
    // stays in the input and on the stale-build notice instead.
    writeChain = writeChain.then(() => isStaleBuild() ? undefined : op().catch(() => {}))
}

async function persistSave(key: string, draft: ChatDraft): Promise<void> {
    if (!draft.m && !draft.t) { await persistRemove(key); return }
    await ensureIndex()
    const bytes = new TextEncoder().encode(JSON.stringify(draft))
    maybeSaved.add(key) // mark before the write: the server may keep it even if the response is lost
    await forageStorage.setItem(key, bytes)
    draftKeys!.add(key)
}

async function persistRemove(key: string): Promise<void> {
    await ensureIndex()
    // Skip only when nothing was ever written for this key; `maybeSaved` covers
    // a save whose response was lost (server has it, but it is not in the index).
    if (!draftKeys!.has(key) && !maybeSaved.has(key)) return
    await forageStorage.removeItem(key)
    draftKeys!.delete(key)
    maybeSaved.delete(key)
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

// The latest text handed in per key this session (typing, flush), so
// copyChatDraft can take what is in the input right now: the debounced save
// of the last keystrokes may not have run yet.
const latest = new Map<string, ChatDraft>()

function cancelPending() {
    if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
    }
}

/**
 * The stored draft of `key`; inside the write queue, or after waiting for it.
 * `trustIndex` false reads even a key the index does not list (one another
 * device saved this session), at the cost of a round trip.
 */
async function readStored(key: string, { trustIndex = true } = {}): Promise<ChatDraft | null> {
    await ensureIndex()
    if (trustIndex && !draftKeys!.has(key)) return null
    try {
        const buf = await forageStorage.getItem(key)
        if (!buf || buf.length === 0) return null
        const obj = JSON.parse(new TextDecoder().decode(buf))
        return { m: obj.m ?? '', t: obj.t ?? '' }
    } catch {
        return null
    }
}

/** Load a chat's draft, or null if none. No round trip when the index says none. */
export async function loadChatDraft(chaId: string, chatId: string): Promise<ChatDraft | null> {
    if (!chaId || !chatId) return null
    // Let any in-flight writes land first so a quick leave→return reads the value
    // we just saved, not a stale one.
    await ensureIndex()
    await writeChain
    return readStored(chatDraftKey(chaId, chatId))
}

/** Debounced save while the user is typing. */
export function scheduleSaveChatDraft(chaId: string, chatId: string, draft: ChatDraft): void {
    if (!chaId || !chatId) return
    const key = chatDraftKey(chaId, chatId)
    latest.set(key, { ...draft })
    cancelPending()
    saveTimer = setTimeout(() => {
        saveTimer = null
        enqueue(() => persistSave(key, draft))
    }, DEBOUNCE_MS)
}

/** Immediate save (blur / chat switch / unmount / page hide). Cancels any pending debounce. */
export function flushChatDraft(chaId: string, chatId: string, draft: ChatDraft): void {
    if (!chaId || !chatId) return
    latest.set(chatDraftKey(chaId, chatId), { ...draft })
    cancelPending()
    enqueue(() => persistSave(chatDraftKey(chaId, chatId), draft))
}

/** Drop a chat's draft after its message is sent. The chat lives on, so the key stays writable. */
export function removeChatDraft(chaId: string, chatId: string): void {
    if (!chaId || !chatId) return
    latest.delete(chatDraftKey(chaId, chatId))
    cancelPending()
    enqueue(() => persistRemove(chatDraftKey(chaId, chatId)))
}

/**
 * A copied chat starts with the unsent text of the chat it was copied from
 * (the user's request, 2026-10-10); that chat keeps its own. Call before
 * switching to the copy, so its draft is queued ahead of the load.
 */
export function copyChatDraft(chaId: string, fromChatId: string, toChatId: string): void {
    if (!chaId || !fromChatId || !toChatId || fromChatId === toChatId) return
    const from = chatDraftKey(chaId, fromChatId)
    const to = chatDraftKey(chaId, toChatId)
    const known = latest.get(from)
    if (known) {
        if (!known.m && !known.t) return
        const draft = { ...known }
        latest.set(to, draft)
        enqueue(() => persistSave(to, draft))
        return
    }
    enqueue(async () => {
        const draft = await readStored(from, { trustIndex: false })
        if (draft && (draft.m || draft.t)) await persistSave(to, draft)
    })
}

/**
 * Remove drafts whose chat no longer exists. One boot pass handles every way a
 * chat can disappear (chat/character deletion, trash purge, plugin/script
 * removal), so individual delete paths need no draft-cleanup wiring. `validKeys`
 * is the set of chatDraftKey() values for all currently existing chats.
 */
export async function sweepOrphanDrafts(validKeys: Set<string>): Promise<void> {
    try {
        const keys = await forageStorage.keys(PREFIX)
        for (const key of keys) {
            if (validKeys.has(key)) continue
            enqueue(async () => {
                await forageStorage.removeItem(key)
                draftKeys?.delete(key)
            })
        }
    } catch {
        // best-effort: orphan drafts are harmless until the next sweep
    }
}
