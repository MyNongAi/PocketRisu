import type { Chat } from './database.svelte'
import { canon, hash64, messageFingerprints, prefixFingerprint } from './chatFingerprint'

// Chat delta sync — transfer only what changed for long chats.
//
// Loading: the browser keeps a copy of recently opened long chats in
// IndexedDB. Opening one sends the copy's message count and prefix
// fingerprint; the server returns only the messages after it when its own
// first messages fingerprint the same, otherwise the whole chat as before.
//
// Saving: the messages the server held after the last sync are remembered as
// fingerprints (memory only). A save sends only the messages after the
// longest unchanged prefix. The server splices them onto its stored chat
// ONLY after verifying that prefix against its own data; on mismatch it
// answers 409 and the full chat is sent. The remembered base only picks how
// much to send — the stored result always equals the client's chat, exactly
// like a full save.
//
// Nothing here puts a partial chat into memory: a chat is either assembled
// complete (verified prefix + fetched rest) or fetched whole.

export interface ChatDeltaTransport {
    fetchChatContentDelta(chaId: string, chatIndex: number, chatId: string, base: { count: number, fp: string } | null): Promise<{ chat: any, deltaBase: number | null } | null>
    saveChatContentDelta(chaId: string, chatIndex: number, chatId: string, chat: any, base: { count: number, fp: string } | null): Promise<'ok' | 'base-mismatch'>
    /** The whole message list the server now holds, where a delta left only part of it in sight (chatMerge.ts). */
    rememberChatBase?(chaId: string, chatId: string, messages: readonly any[]): void
}

export interface ChatCopyStore {
    get(key: string): Promise<Chat | null>
    put(key: string, chat: Chat): Promise<void>
}

// Only long chats are worth a local copy; short ones load fast anyway.
export const CACHE_MIN_MESSAGES = 40
export const CACHE_MAX_ENTRIES = 24

function chatCopyKey(chaId: string, chatId: string) {
    return `${chaId}|${chatId}`
}

function isUsableCopy(chat: any): chat is Chat {
    return !!chat && typeof chat === 'object' && Array.isArray(chat.message) && chat.message.length > 0 && !chat._placeholder
}

/**
 * A whole chat body as one hash: the messages by fingerprint, every other
 * field as it is except `copied` ones. A save passes the fingerprints it
 * computes anyway, so only the fields besides the messages cost extra.
 */
export function chatBodySignature(
    chat: Chat,
    fingerprints: readonly string[] = messageFingerprints(chat.message ?? []),
    copied: readonly string[] = [],
): string {
    const { message: _message, ...rest } = chat as Chat & Record<string, unknown>
    for (const field of copied) delete rest[field]
    return hash64(`${fingerprints.length}|${fingerprints.join('')}|${canon(rest)}`)
}

export function createChatDeltaSync(transport: ChatDeltaTransport, copies: ChatCopyStore, options: {
    /**
     * Fields a body holds only as copies, which the server replaces with its
     * own (chatStorage CATALOG_FIELDS): a change to them alone is no reason
     * to send the body again.
     */
    copiedFields?: readonly string[]
} = {}) {
    const bodySignature = (chat: Chat, fingerprints?: readonly string[]) => chatBodySignature(chat, fingerprints, options.copiedFields)
    const serverFingerprints = new Map<string, string[]>()
    // Each chat as the server holds it, as far as this page knows
    // (chatBodySignature): what it last saved, once the server acknowledged
    // that save, or the server's copy it took (rememberServerBody).
    const savedBodies = new Map<string, string>()

    async function fetchChat(chaId: string, chatIndex: number, chatId: string): Promise<Chat | null> {
        const key = chatCopyKey(chaId, chatId)
        let copy: Chat | null = null
        try {
            const stored = await copies.get(key)
            if (isUsableCopy(stored)) copy = stored
        } catch {
            copy = null
        }
        const copyFingerprints = copy ? messageFingerprints(copy.message) : null
        const base = copy && copyFingerprints
            ? { count: copy.message.length, fp: prefixFingerprint(copyFingerprints, copy.message.length) }
            : null

        const result = await transport.fetchChatContentDelta(chaId, chatIndex, chatId, base)
        if (!result) return null

        let full: Chat = result.chat
        let fingerprints: string[]
        if (result.deltaBase !== null && copy && copyFingerprints && result.deltaBase === copy.message.length) {
            full = { ...result.chat, message: copy.message.concat(result.chat.message) }
            fingerprints = copyFingerprints.concat(messageFingerprints(result.chat.message))
        } else {
            fingerprints = messageFingerprints(full.message ?? [])
        }
        serverFingerprints.set(key, fingerprints)
        transport.rememberChatBase?.(chaId, chatId, full.message ?? [])

        if ((full.message?.length ?? 0) >= CACHE_MIN_MESSAGES) {
            // Clone now, while `full` is still a plain object (it becomes
            // reactive state once the caller applies it).
            let snapshot: Chat | null = null
            try {
                snapshot = structuredClone(full)
            } catch {
                snapshot = null
            }
            if (snapshot) void copies.put(key, snapshot).catch(() => {})
        }
        return full
    }

    // Saves of one chat run one at a time, in call order: autosave, job
    // recovery and plugin writes all save through here, and a slower earlier
    // request finishing last would replace the newer chat on the server.
    // With nothing in flight a save starts at once, so its content is taken
    // at the call as before.
    const saveQueues = new Map<string, Promise<void>>()

    function saveChat(chaId: string, chatIndex: number, chatId: string, chat: Chat): Promise<void> {
        const key = chatCopyKey(chaId, chatId)
        const previous = saveQueues.get(key)
        const run = previous
            ? previous.then(() => saveChatNow(chaId, chatIndex, chatId, chat))
            : saveChatNow(chaId, chatIndex, chatId, chat)
        const settled = run.then(() => {}, () => {})
        saveQueues.set(key, settled)
        void settled.then(() => {
            if (saveQueues.get(key) === settled) saveQueues.delete(key)
        })
        return run
    }

    async function saveChatNow(chaId: string, chatIndex: number, chatId: string, chat: Chat): Promise<void> {
        const key = chatCopyKey(chaId, chatId)
        const messages = chat.message ?? []
        // Fingerprints, delta body and encoding are all taken synchronously
        // below, so they describe the same chat content even if it keeps
        // changing (streaming) while the request is in flight.
        const fingerprints = messageFingerprints(messages)
        const body = bodySignature(chat, fingerprints)
        // Until this save is acknowledged the server may hold either copy.
        savedBodies.delete(key)
        const known = serverFingerprints.get(key)
        let shared = 0
        if (known) {
            const max = Math.min(known.length, fingerprints.length)
            while (shared < max && known[shared] === fingerprints[shared]) shared++
        }
        if (shared > 0) {
            const delta = { ...chat, message: messages.slice(shared) }
            const outcome = await transport.saveChatContentDelta(chaId, chatIndex, chatId, delta, {
                count: shared,
                fp: prefixFingerprint(fingerprints, shared),
            })
            if (outcome === 'ok') {
                serverFingerprints.set(key, fingerprints)
                savedBodies.set(key, body)
                transport.rememberChatBase?.(chaId, chatId, messages)
                return
            }
            // The server holds something else (another device, a server-side
            // write): fall through to a full save, as before delta sync.
        }
        await transport.saveChatContentDelta(chaId, chatIndex, chatId, chat, null)
        serverFingerprints.set(key, fingerprints)
        // The full save encodes the chat after the await above, so it may
        // hold more than `body`; the chat then no longer matches, and the
        // next save sends it again rather than skip it.
        savedBodies.set(key, body)
    }

    /**
     * Whether `chat` is, field for field, what this page last saved of it or
     * took from the server. Sending it again would only repeat that, or
     * overwrite what another device saved since.
     */
    function savedBodyMatches(chaId: string, chatId: string, chat: Chat): boolean {
        const saved = savedBodies.get(chatCopyKey(chaId, chatId))
        return saved !== undefined && saved === bodySignature(chat)
    }

    /** This page now holds the server's copy of the chat as it is. */
    function rememberServerBody(chaId: string, chatId: string, chat: Chat): void {
        savedBodies.set(chatCopyKey(chaId, chatId), bodySignature(chat))
    }

    return { fetchChat, saveChat, savedBodyMatches, rememberServerBody }
}

// ── IndexedDB copy store ────────────────────────────────────────────────────

const DB_NAME = 'pocketrisu-chat-copies'
const STORE = 'chats'

let dbPromise: Promise<IDBDatabase> | null = null

function openCopyDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB unavailable'))
            return
        }
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'key' })
                store.createIndex('usedAt', 'usedAt')
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
    dbPromise.catch(() => { dbPromise = null })
    return dbPromise
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
    })
}

export const indexedDbChatCopies: ChatCopyStore = {
    async get(key) {
        const db = await openCopyDb()
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        const record = await new Promise<any>((resolve, reject) => {
            const request = store.get(key)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        if (record) store.put({ ...record, usedAt: Date.now() })
        await done(tx)
        return record?.chat ?? null
    },
    async put(key, chat) {
        const db = await openCopyDb()
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        store.put({ key, chat, usedAt: Date.now() })
        // Evict least recently used copies beyond the cap.
        const countRequest = store.count()
        countRequest.onsuccess = () => {
            let excess = countRequest.result - CACHE_MAX_ENTRIES
            if (excess <= 0) return
            const cursorRequest = store.index('usedAt').openCursor()
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result
                if (!cursor || excess <= 0) return
                if (cursor.primaryKey !== key) {
                    cursor.delete()
                    excess--
                }
                cursor.continue()
            }
        }
        await done(tx)
    },
}
