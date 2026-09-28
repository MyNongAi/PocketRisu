// Encrypted segment cache for the delta boot of database.bin (bootPayload.ts,
// POST /api/db/boot).
//
// The server splits database.bin into content-addressed segments (the msgpack
// bytes of each root entry, character and module) named by the first 16 bytes
// of their SHA-256. This cache keeps the segments of the last boot so the next
// one downloads only the segments that changed.
//
// The database holds private chats and provider API keys, so nothing is stored
// in plaintext: every record is AES-GCM encrypted with a key the server derives
// from its own secret and sends in the authenticated boot response. The key is
// imported non-extractable, lives only in memory for one boot, and is never
// persisted here. A stolen device without server access cannot read the cache.
//
// IndexedDB `pocketrisu-boot-cache` v1:
// - `segments`: key = 16-byte digest, value = { iv, ct, len }; the ciphertext's
//   additional data is digest ‖ u32be(len), so records cannot be swapped.
// - `state`, key 'current': the manifest of the last committed boot.
// A commit writes missing segments in transactions of at most about 16MB, then
// one final transaction checks that every manifest segment is present, writes
// the state and deletes every segment the state does not reference. A reload
// or quota error mid-way leaves the previous state valid; orphans are collected
// by the next commit.

export const BOOT_CACHE_DB_NAME = 'pocketrisu-boot-cache'
export const BOOT_CACHE_LOCK_NAME = 'pocketrisu-boot-cache'
/** localStorage kill switch: 'off' disables the delta boot on this device. */
export const BOOT_CACHE_FLAG_KEY = 'risu-boot-cache'
const BOOT_CACHE_FALLBACKS_KEY = 'risu-boot-cache-fallbacks'
const BOOT_CACHE_SUSPENDED_KEY = 'risu-boot-cache-suspended'
const SEGMENTS_STORE = 'segments'
const STATE_STORE = 'state'
const STATE_KEY = 'current'
export const BOOT_DIGEST_BYTES = 16
const IV_BYTES = 12
const KEY_BYTES = 32
const DEFAULT_MAX_TRANSACTION_BYTES = 16 * 1024 * 1024
/** A commit starts this long after the boot that produced it, off the boot path. */
export const BOOT_COMMIT_DELAY_MS = 4_000
const FALLBACKS_BEFORE_SUSPEND = 2

export interface BootCacheState {
    v: 1
    planVersion: 1
    keyId: string
    etag: string
    prefix: Uint8Array
    /** N × 16-byte digests, in manifest order. */
    digests: Uint8Array
    lens: Uint32Array
    total: number
    savedAt: number
}

export interface BootSegmentRecord {
    iv: Uint8Array
    ct: ArrayBuffer
    len: number
}

export interface BootCacheCommitArgs {
    subtle: SubtleCrypto
    key: CryptoKey
    keyId: string
    etag: string
    prefix: Uint8Array
    digests: Uint8Array
    lens: Uint32Array
    total: number
    /** Plaintext of a segment this boot downloaded, by hex digest; null if not held. */
    bytesFor: (hex: string) => Uint8Array | null
    maxTransactionBytes?: number
    now?: () => number
}

export interface BootCacheCommitResult {
    ok: boolean
    reason?: string
    written: number
    writtenBytes: number
    deleted: number
    ms: number
}

export interface BootCacheStats {
    segments: number
    state: BootCacheState | null
}

/**
 * What the boot loader needs from a segment cache. `getSegments` reads a
 * batch in one transaction; missing records come back as null.
 */
export interface BootSegmentCache {
    loadState(): Promise<BootCacheState | null>
    getSegments(digests: readonly Uint8Array[]): Promise<(BootSegmentRecord | null)[]>
    commit(args: BootCacheCommitArgs): Promise<BootCacheCommitResult>
    clear(): Promise<void>
    stats(): Promise<BootCacheStats>
}

// ── Digests and crypto ──────────────────────────────────────────────────────

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

export function toHex(bytes: Uint8Array, offset = 0, length = bytes.length - offset): string {
    let out = ''
    for (let i = 0; i < length; i++) out += HEX[bytes[offset + i]]
    return out
}

/** Hex of the `index`-th 16-byte digest in a packed digest list. */
export function digestHexAt(digests: Uint8Array, index: number): string {
    return toHex(digests, index * BOOT_DIGEST_BYTES, BOOT_DIGEST_BYTES)
}

/** AES-GCM additional data of a record: digest ‖ u32be(len). */
export function segmentAad(digest: Uint8Array, len: number): Uint8Array<ArrayBuffer> {
    const aad = new Uint8Array(BOOT_DIGEST_BYTES + 4)
    aad.set(digest.subarray(0, BOOT_DIGEST_BYTES), 0)
    new DataView(aad.buffer).setUint32(BOOT_DIGEST_BYTES, len, false)
    return aad
}

/** Import the server-sent cache key; non-extractable, never stored. */
export function importBootCacheKey(subtle: SubtleCrypto, raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    if (raw.length !== KEY_BYTES) throw new Error('boot cache key must be 32 bytes')
    return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptSegment(
    subtle: SubtleCrypto,
    key: CryptoKey,
    digest: Uint8Array,
    bytes: Uint8Array,
): Promise<BootSegmentRecord> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const ct = await subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: segmentAad(digest, bytes.length) },
        key,
        bytes as Uint8Array<ArrayBuffer>,
    )
    return { iv, ct, len: bytes.length }
}

/**
 * Decrypt and authenticate a record for `digest`/`len`. Throws when the record
 * does not belong to that digest and length or was altered.
 */
export async function decryptSegment(
    subtle: SubtleCrypto,
    key: CryptoKey,
    digest: Uint8Array,
    len: number,
    record: BootSegmentRecord,
): Promise<Uint8Array<ArrayBuffer>> {
    if (!validRecord(record) || record.len !== len) throw new Error('boot cache record does not match the manifest')
    const plain = await subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(record.iv), additionalData: segmentAad(digest, len) },
        key,
        record.ct,
    )
    if (plain.byteLength !== len) throw new Error('boot cache record has the wrong length')
    return new Uint8Array(plain)
}

function validRecord(record: unknown): record is BootSegmentRecord {
    const r = record as BootSegmentRecord
    return !!r
        && r.iv instanceof Uint8Array && r.iv.length === IV_BYTES
        && r.ct instanceof ArrayBuffer
        && Number.isInteger(r.len) && r.len >= 0
}

export function validBootCacheState(value: unknown): BootCacheState | null {
    const s = value as BootCacheState
    if (!s || s.v !== 1 || s.planVersion !== 1) return null
    if (typeof s.keyId !== 'string' || typeof s.etag !== 'string') return null
    if (!(s.prefix instanceof Uint8Array) || !(s.digests instanceof Uint8Array) || !(s.lens instanceof Uint32Array)) return null
    if (s.digests.length !== s.lens.length * BOOT_DIGEST_BYTES) return null
    if (!Number.isSafeInteger(s.total) || s.total < 0) return null
    return s
}

// ── Commit algorithm, shared by every store ─────────────────────────────────

interface FinalizeResult {
    ok: boolean
    deleted: number
}

/**
 * The commit and read logic over a minimal transactional store. The IndexedDB
 * and in-memory caches only implement the primitives, so the tests exercise
 * the same commit path the browser runs.
 */
abstract class StoredBootSegmentCache implements BootSegmentCache {
    protected abstract readState(): Promise<unknown>
    protected abstract readRecords(digests: readonly Uint8Array[]): Promise<unknown[]>
    protected abstract listKeys(): Promise<string[]>
    protected abstract putRecords(entries: Array<[Uint8Array, BootSegmentRecord]>): Promise<void>
    /**
     * All or nothing: when every digest in `required` is present, write
     * `state` and delete every segment whose hex is not in `keep`; otherwise
     * change nothing and return ok false.
     */
    protected abstract finalize(state: BootCacheState, required: Uint8Array[], keep: Set<string>): Promise<FinalizeResult>
    protected abstract wipe(): Promise<void>
    protected abstract countRecords(): Promise<number>
    protected abstract exclusive<T>(fn: () => Promise<T>): Promise<T>

    async loadState(): Promise<BootCacheState | null> {
        return validBootCacheState(await this.readState())
    }

    async getSegments(digests: readonly Uint8Array[]): Promise<(BootSegmentRecord | null)[]> {
        if (digests.length === 0) return []
        const records = await this.readRecords(digests)
        return records.map((record) => validRecord(record) ? record : null)
    }

    commit(args: BootCacheCommitArgs): Promise<BootCacheCommitResult> {
        return this.exclusive(() => this.runCommit(args))
    }

    clear(): Promise<void> {
        return this.exclusive(() => this.wipe())
    }

    async stats(): Promise<BootCacheStats> {
        const [segments, state] = await Promise.all([this.countRecords(), this.loadState()])
        return { segments, state }
    }

    private async runCommit(args: BootCacheCommitArgs): Promise<BootCacheCommitResult> {
        const now = args.now ?? (() => performance.now())
        const started = now()
        const maxTx = args.maxTransactionBytes ?? DEFAULT_MAX_TRANSACTION_BYTES
        let written = 0
        let writtenBytes = 0
        const result = (ok: boolean, extra: Partial<BootCacheCommitResult> = {}): BootCacheCommitResult => ({
            ok, written, writtenBytes, deleted: 0, ms: Math.round(now() - started), ...extra,
        })

        // Records are only readable under the key of the state that lists
        // them. A different key, or no state at all (a first fill, or one cut
        // off before its final transaction), starts from an empty store.
        const previous = await this.loadState()
        const wiped = !previous || previous.keyId !== args.keyId
        if (wiped) await this.wipe()
        const present = wiped ? new Set<string>() : new Set(await this.listKeys())

        const count = args.lens.length
        const required: Uint8Array[] = []
        const keep = new Set<string>()
        let batch: Array<{ digest: Uint8Array, bytes: Uint8Array }> = []
        let batchBytes = 0
        const flush = async () => {
            if (batch.length === 0) return
            const jobs = batch
            batch = []
            batchBytes = 0
            const entries = await Promise.all(jobs.map(async ({ digest, bytes }) =>
                [digest, await encryptSegment(args.subtle, args.key, digest, bytes)] as [Uint8Array, BootSegmentRecord]))
            await this.putRecords(entries)
            written += entries.length
            for (const job of jobs) writtenBytes += job.bytes.length
        }

        for (let i = 0; i < count; i++) {
            const hex = digestHexAt(args.digests, i)
            if (keep.has(hex)) continue
            keep.add(hex)
            const digest = args.digests.slice(i * BOOT_DIGEST_BYTES, (i + 1) * BOOT_DIGEST_BYTES)
            required.push(digest)
            if (present.has(hex)) continue
            const bytes = args.bytesFor(hex)
            // A segment this boot read from the cache that another tab's
            // commit removed since: nothing to write it from. The old state
            // stays; the next boot downloads it.
            if (!bytes || bytes.length !== args.lens[i]) return result(false, { reason: 'segment-unavailable' })
            batch.push({ digest, bytes })
            batchBytes += bytes.length
            if (batchBytes >= maxTx) await flush()
        }
        await flush()

        const state: BootCacheState = {
            v: 1,
            planVersion: 1,
            keyId: args.keyId,
            etag: args.etag,
            prefix: args.prefix.slice(),
            digests: args.digests.slice(),
            lens: args.lens.slice(),
            total: args.total,
            savedAt: Date.now(),
        }
        const final = await this.finalize(state, required, keep)
        if (!final.ok) return result(false, { reason: 'segment-missing-at-final' })
        return result(true, { deleted: final.deleted })
    }
}

// ── In-memory store (tests, and the reference for the IndexedDB one) ───────

export class MemoryBootSegmentCache extends StoredBootSegmentCache {
    state: BootCacheState | null = null
    readonly segments = new Map<string, BootSegmentRecord>()
    /** Operation log, to observe commit interleaving in tests. */
    readonly ops: string[] = []
    /** Make the next final transaction abort (quota error, reload). */
    failNextFinalize = false
    private chain: Promise<unknown> = Promise.resolve()

    protected async readState(): Promise<unknown> {
        return this.state
    }

    protected async readRecords(digests: readonly Uint8Array[]): Promise<unknown[]> {
        return digests.map((digest) => this.segments.get(toHex(digest)) ?? null)
    }

    protected async listKeys(): Promise<string[]> {
        return [...this.segments.keys()]
    }

    protected async putRecords(entries: Array<[Uint8Array, BootSegmentRecord]>): Promise<void> {
        this.ops.push(`put:${entries.length}`)
        // Yield like a real transaction so concurrent commits could interleave.
        await Promise.resolve()
        for (const [digest, record] of entries) this.segments.set(toHex(digest), record)
    }

    protected async finalize(state: BootCacheState, required: Uint8Array[], keep: Set<string>): Promise<FinalizeResult> {
        this.ops.push('final')
        await Promise.resolve()
        if (this.failNextFinalize) {
            this.failNextFinalize = false
            throw new Error('simulated final transaction abort')
        }
        if (required.some((digest) => !this.segments.has(toHex(digest)))) return { ok: false, deleted: 0 }
        let deleted = 0
        for (const hex of [...this.segments.keys()]) {
            if (!keep.has(hex)) {
                this.segments.delete(hex)
                deleted++
            }
        }
        this.state = state
        return { ok: true, deleted }
    }

    protected async wipe(): Promise<void> {
        this.ops.push('wipe')
        this.segments.clear()
        this.state = null
    }

    protected async countRecords(): Promise<number> {
        return this.segments.size
    }

    protected exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.chain.then(fn, fn)
        this.chain = run.catch(() => {})
        return run
    }
}

// ── IndexedDB store ─────────────────────────────────────────────────────────

interface LockManagerLike {
    request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

function digestKey(digest: Uint8Array): ArrayBuffer {
    return digest.slice(0, BOOT_DIGEST_BYTES).buffer
}

function keyHex(key: IDBValidKey): string {
    if (key instanceof ArrayBuffer) return toHex(new Uint8Array(key))
    if (ArrayBuffer.isView(key)) return toHex(new Uint8Array(key.buffer, key.byteOffset, key.byteLength))
    return String(key)
}

function transactionDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error ?? new Error('boot cache transaction aborted'))
        tx.onerror = () => { /* onabort follows and reports it */ }
    })
}

export class IdbBootSegmentCache extends StoredBootSegmentCache {
    private dbPromise: Promise<IDBDatabase> | null = null

    constructor(
        private readonly idb: IDBFactory,
        private readonly locks: LockManagerLike,
    ) {
        super()
    }

    private open(): Promise<IDBDatabase> {
        this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
            const request = this.idb.open(BOOT_CACHE_DB_NAME, 1)
            request.onupgradeneeded = () => {
                const db = request.result
                if (!db.objectStoreNames.contains(SEGMENTS_STORE)) db.createObjectStore(SEGMENTS_STORE)
                if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE)
            }
            request.onsuccess = () => {
                const db = request.result
                const reset = () => {
                    db.close()
                    this.dbPromise = null
                }
                db.onversionchange = reset
                db.onclose = () => { this.dbPromise = null }
                resolve(db)
            }
            request.onerror = () => reject(request.error ?? new Error('boot cache open failed'))
            request.onblocked = () => reject(new Error('boot cache open blocked'))
        }).catch((error) => {
            this.dbPromise = null
            throw error
        })
        return this.dbPromise
    }

    protected async readState(): Promise<unknown> {
        const db = await this.open()
        const tx = db.transaction(STATE_STORE, 'readonly')
        const request = tx.objectStore(STATE_STORE).get(STATE_KEY)
        await transactionDone(tx)
        return request.result ?? null
    }

    protected async readRecords(digests: readonly Uint8Array[]): Promise<unknown[]> {
        const db = await this.open()
        const tx = db.transaction(SEGMENTS_STORE, 'readonly')
        const store = tx.objectStore(SEGMENTS_STORE)
        const requests = digests.map((digest) => store.get(digestKey(digest)))
        await transactionDone(tx)
        return requests.map((request) => request.result ?? null)
    }

    protected async listKeys(): Promise<string[]> {
        const db = await this.open()
        const tx = db.transaction(SEGMENTS_STORE, 'readonly')
        const request = tx.objectStore(SEGMENTS_STORE).getAllKeys()
        await transactionDone(tx)
        return request.result.map(keyHex)
    }

    protected async putRecords(entries: Array<[Uint8Array, BootSegmentRecord]>): Promise<void> {
        const db = await this.open()
        const tx = db.transaction(SEGMENTS_STORE, 'readwrite')
        const store = tx.objectStore(SEGMENTS_STORE)
        for (const [digest, record] of entries) store.put(record, digestKey(digest))
        await transactionDone(tx)
    }

    protected async finalize(state: BootCacheState, required: Uint8Array[], keep: Set<string>): Promise<FinalizeResult> {
        const db = await this.open()
        // Plain request callbacks only: the decision to write or abort must
        // happen while the transaction is still active.
        return new Promise<FinalizeResult>((resolve, reject) => {
            const tx = db.transaction([SEGMENTS_STORE, STATE_STORE], 'readwrite')
            const segments = tx.objectStore(SEGMENTS_STORE)
            let missing = false
            let abortedOnPurpose = false
            let deleted = 0
            let allKeys: IDBValidKey[] = []
            let pending = required.length + 1
            const settleOne = () => {
                if (--pending > 0) return
                if (missing) {
                    abortedOnPurpose = true
                    tx.abort()
                    return
                }
                for (const key of allKeys) {
                    if (keep.has(keyHex(key))) continue
                    segments.delete(key)
                    deleted++
                }
                tx.objectStore(STATE_STORE).put(state, STATE_KEY)
            }
            for (const digest of required) {
                const request = segments.count(digestKey(digest))
                request.onsuccess = () => {
                    if (request.result === 0) missing = true
                    settleOne()
                }
            }
            const keysRequest = segments.getAllKeys()
            keysRequest.onsuccess = () => {
                allKeys = keysRequest.result
                settleOne()
            }
            tx.oncomplete = () => resolve({ ok: true, deleted })
            tx.onabort = () => {
                if (abortedOnPurpose) resolve({ ok: false, deleted: 0 })
                else reject(tx.error ?? new Error('boot cache final transaction aborted'))
            }
        })
    }

    protected async wipe(): Promise<void> {
        const db = await this.open()
        const tx = db.transaction([SEGMENTS_STORE, STATE_STORE], 'readwrite')
        tx.objectStore(SEGMENTS_STORE).clear()
        tx.objectStore(STATE_STORE).clear()
        await transactionDone(tx)
    }

    protected async countRecords(): Promise<number> {
        const db = await this.open()
        const tx = db.transaction(SEGMENTS_STORE, 'readonly')
        const request = tx.objectStore(SEGMENTS_STORE).count()
        await transactionDone(tx)
        return request.result
    }

    protected exclusive<T>(fn: () => Promise<T>): Promise<T> {
        return this.locks.request(BOOT_CACHE_LOCK_NAME, fn)
    }
}

// ── Policy: when the delta boot runs, kill switches, suspension ─────────────

interface KeyValueStore {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
}

export interface BootCacheEnv {
    subtle: SubtleCrypto | null
    hasIndexedDB: boolean
    hasLocks: boolean
    hostname: string
    /** Persistent flags (localStorage). */
    local: KeyValueStore | null
    /** Per-tab-session flags (sessionStorage). */
    session: KeyValueStore | null
    createCache(): BootSegmentCache
    /** Run `fn` after `ms`; returns a cancel function. */
    schedule(fn: () => void, ms: number): () => void
    log(level: 'info' | 'warning' | 'error', message: string): void
}

export interface BootCacheStatus {
    supported: boolean
    userDisabled: boolean
    suspended: string | null
    segments: number | null
    cachedBytes: number | null
    etag: string | null
    savedAt: number | null
}

export function isLoopbackHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function safeGet(store: KeyValueStore | null, key: string): string | null {
    try { return store?.getItem(key) ?? null } catch { return null }
}
function safeSet(store: KeyValueStore | null, key: string, value: string | null) {
    try {
        if (value === null) store?.removeItem(key)
        else store?.setItem(key, value)
    } catch { /* storage unavailable: the flag lasts for this page only */ }
}

/**
 * Decides whether a boot uses the segment cache and owns the background
 * commit. Suspension (after an x-db-hash mismatch or two consecutive
 * fallbacks) clears the cache and turns it off for this tab session.
 */
export class BootCacheController {
    private cacheInstance: BootSegmentCache | null = null
    private cancelPendingCommit: (() => void) | null = null
    private suspendedInMemory: string | null = null
    private clearedWhileDisabled = false

    constructor(readonly env: BootCacheEnv) {}

    get subtle(): SubtleCrypto | null {
        return this.env.subtle
    }

    /** WebCrypto, IndexedDB and Web Locks exist, and the host is not loopback. */
    supported(): boolean {
        return !!this.env.subtle && this.env.hasIndexedDB && this.env.hasLocks && !isLoopbackHost(this.env.hostname)
    }

    userDisabled(): boolean {
        return safeGet(this.env.local, BOOT_CACHE_FLAG_KEY) === 'off'
    }

    suspendedReason(): string | null {
        return this.suspendedInMemory ?? safeGet(this.env.session, BOOT_CACHE_SUSPENDED_KEY)
    }

    usable(): boolean {
        if (!this.supported()) return false
        if (this.userDisabled()) {
            // A device switched off keeps no encrypted copy around.
            if (!this.clearedWhileDisabled) {
                this.clearedWhileDisabled = true
                void this.clear().catch(() => {})
            }
            return false
        }
        return this.suspendedReason() === null
    }

    cache(): BootSegmentCache {
        this.cacheInstance ??= this.env.createCache()
        return this.cacheInstance
    }

    noteSuccess(): void {
        safeSet(this.env.local, BOOT_CACHE_FALLBACKS_KEY, null)
    }

    /** Count a boot that had to use the legacy read; the second in a row suspends. */
    noteFallback(reason: string): void {
        const count = (Number(safeGet(this.env.local, BOOT_CACHE_FALLBACKS_KEY)) || 0) + 1
        if (count >= FALLBACKS_BEFORE_SUSPEND) {
            safeSet(this.env.local, BOOT_CACHE_FALLBACKS_KEY, null)
            this.suspend(`fallbacks (${reason})`)
            return
        }
        safeSet(this.env.local, BOOT_CACHE_FALLBACKS_KEY, String(count))
    }

    /** Clear the cache and keep it off for this tab session. */
    suspend(reason: string): void {
        if (this.suspendedReason() !== null) return
        this.suspendedInMemory = reason
        safeSet(this.env.session, BOOT_CACHE_SUSPENDED_KEY, reason)
        this.env.log('warning', `[BootCache] Suspended for this session: ${reason}`)
        void this.clear().catch((error) => {
            this.env.log('warning', `[BootCache] Clearing after suspension failed: ${String(error)}`)
        })
    }

    /** Run `commit` in the background once boot has settled. */
    scheduleCommit(commit: () => Promise<BootCacheCommitResult>, delayMs = BOOT_COMMIT_DELAY_MS): void {
        this.cancelPendingCommit?.()
        let cancelled = false
        const cancelTimer = this.env.schedule(() => {
            this.cancelPendingCommit = null
            if (cancelled || !this.usable()) return
            void commit().then((result) => {
                if (result.ok) {
                    this.env.log('info', `[BootCache] Stored ${result.written} new segments (${result.writtenBytes} bytes), removed ${result.deleted}, ${result.ms}ms`)
                } else {
                    this.env.log('info', `[BootCache] Commit skipped: ${result.reason}`)
                }
            }, (error) => {
                // Quota or IndexedDB failure: stop writing for this session
                // rather than repeating a large background write.
                this.suspend(`commit failed: ${error instanceof Error ? error.name : String(error)}`)
            })
        }, delayMs)
        this.cancelPendingCommit = () => {
            cancelled = true
            cancelTimer()
            this.cancelPendingCommit = null
        }
    }

    async clear(): Promise<void> {
        this.cancelPendingCommit?.()
        if (!this.env.hasIndexedDB || !this.env.hasLocks) return
        await this.cache().clear()
    }

    async status(): Promise<BootCacheStatus> {
        const status: BootCacheStatus = {
            supported: this.supported(),
            userDisabled: this.userDisabled(),
            suspended: this.suspendedReason(),
            segments: null,
            cachedBytes: null,
            etag: null,
            savedAt: null,
        }
        if (!this.env.hasIndexedDB || !this.env.hasLocks) return status
        try {
            const stats = await this.cache().stats()
            status.segments = stats.segments
            status.cachedBytes = stats.state?.total ?? 0
            status.etag = stats.state?.etag ?? null
            status.savedAt = stats.state?.savedAt ?? null
        } catch { /* status is best effort */ }
        return status
    }
}

function browserStore(get: () => Storage): KeyValueStore | null {
    try {
        return get() ?? null
    } catch {
        return null
    }
}

export function browserBootCacheEnv(): BootCacheEnv {
    const g = globalThis as typeof globalThis & { indexedDB?: IDBFactory }
    let hostname = ''
    try { hostname = g.location?.hostname ?? '' } catch { /* no location */ }
    const locks = (g.navigator as Navigator & { locks?: LockManagerLike } | undefined)?.locks
    return {
        subtle: g.crypto?.subtle ?? null,
        hasIndexedDB: !!g.indexedDB,
        hasLocks: typeof locks?.request === 'function',
        hostname,
        local: browserStore(() => g.localStorage),
        session: browserStore(() => g.sessionStorage),
        createCache: () => new IdbBootSegmentCache(g.indexedDB, locks),
        schedule: (fn, ms) => {
            const timer = setTimeout(fn, ms)
            return () => clearTimeout(timer)
        },
        log: (level, message) => {
            if (level === 'info') console.info(message)
            else console.warn(message)
            // Lazy: log.ts reaches globalApi when it flushes.
            void import('../log').then(({ addLog }) => addLog({ level, source: 'boot', message })).catch(() => {})
        },
    }
}
