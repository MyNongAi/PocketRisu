// Delta boot of database.bin: POST /api/db/boot, protocol v1.
//
// The client uploads the 16-byte digests of the segments its encrypted cache
// holds (bootPayloadCache.ts). The server answers with the full manifest of
// the current database.bin and the bytes of only the segments the client
// lacks. The client rebuilds exactly the bytes GET /api/read would have
// returned, so the decode and the patch baseline are those of a full read.
//
// Nothing unverified reaches the decoder: every segment's SHA-256/128 is
// compared with the manifest, and the manifest's Merkle root with x-db-etag.
// Any failure is a BootFallback, and the caller uses the legacy /api/read.
//
// Response body (all integers big-endian):
//   'P' 'R' 'B' '1' | u8 flags (bit0 = key present)
//   [u8 keyIdLen, keyId ascii, u8 32, key[32]]          only when bit0 is set
//   u32 prefixLen (≤ 64), prefix
//   u32 segCount (≤ 1,048,576)
//   segCount × { digest[16], u32 len, u8 included }
//   the included segments' bytes, in manifest order
// database.bin = prefix ‖ segment 0 ‖ segment 1 ‖ …
// x-db-etag = 'm1-' + hex(sha256(0x01 ‖ prefix ‖ Σ(digest ‖ u32be(len))))[0..40]

import {
    BOOT_DIGEST_BYTES,
    decryptSegment,
    digestHexAt,
    importBootCacheKey,
    toHex,
    type BootCacheCommitResult,
    type BootCacheState,
    type BootSegmentCache,
} from './bootPayloadCache'

export const BOOT_ENDPOINT = '/api/db/boot'
export const BOOT_PROTOCOL_VERSION = '1'
export const BOOT_CONTENT_TYPE = 'application/x-pocketrisu-boot'
const MAGIC = [0x50, 0x52, 0x42, 0x31] // 'PRB1'
const FLAG_KEY_PRESENT = 0x01
const KEY_BYTES = 32
const MANIFEST_ENTRY_BYTES = BOOT_DIGEST_BYTES + 4 + 1
export const MAX_PREFIX_BYTES = 64
export const MAX_SEGMENTS = 1_048_576
/** The server refuses larger have-lists (413); send at most this many. */
export const MAX_HAVE_DIGESTS = 262_144
/** Sanity bound on the assembled size; far above any real database.bin. */
export const DEFAULT_MAX_TOTAL = 0x7fff_ffff
const DEFAULT_MAX_CACHE_IN_FLIGHT = 32 * 1024 * 1024
const DEFAULT_MAX_VERIFY_IN_FLIGHT = 16 * 1024 * 1024
const MAX_CACHE_BATCH_BYTES = 8 * 1024 * 1024
const MAX_CACHE_BATCH_COUNT = 64
const MAX_PARALLEL_TASKS = 8
/**
 * Up to this many downloaded bytes are copied out for the background commit,
 * so the caller can drop the assembled payload once it is decoded. Above it
 * (a first fill) the commit keeps the payload itself instead of a copy.
 */
const COMMIT_COPY_LIMIT = 64 * 1024 * 1024

/** The delta boot cannot be used for this load; read database.bin the legacy way. */
export class BootFallback extends Error {
    readonly reason: string

    constructor(reason: string, message?: string, options?: { cause?: unknown }) {
        super(message ? `${reason}: ${message}` : reason, options)
        this.name = 'BootFallback'
        this.reason = reason
    }
}

/**
 * An authentication failure: propagate it as the legacy read would have.
 * `response` is set for a 401/403 answer, `cause` for an error the
 * authenticated fetch raised itself (login refused, password prompt).
 */
export class BootAuthError extends Error {
    readonly response: Response | null

    constructor(options: { response?: Response, cause?: unknown }) {
        super(options.response ? `boot request refused with HTTP ${options.response.status}` : 'boot request authentication failed', { cause: options.cause })
        this.name = 'BootAuthError'
        this.response = options.response ?? null
    }
}

export interface BootManifest {
    keyId: string | null
    /** Raw cache key; zeroed once imported. */
    key: Uint8Array<ArrayBuffer> | null
    prefix: Uint8Array<ArrayBuffer>
    /** segCount × 16 bytes. */
    digests: Uint8Array<ArrayBuffer>
    lens: Uint32Array<ArrayBuffer>
    /** 1 when the segment's bytes follow in the response. */
    included: Uint8Array<ArrayBuffer>
    total: number
    includedBytes: number
}

export interface BootLoadStats {
    total: number
    includedBytes: number
    segments: number
    networkSegments: number
    cachedSegments: number
    headerTotal: number | null
    headerIncluded: number | null
    ms: number
}

export interface BootLoadResult {
    /** null when the server has no database yet (204). */
    bytes: Uint8Array<ArrayBuffer> | null
    etag: string | null
    cursor: { instanceId: string, seq: number } | null
    dbHash: string | null
    /** Stores what this boot downloaded; run it in the background. */
    commit: (() => Promise<BootCacheCommitResult>) | null
    stats: BootLoadStats | null
}

export interface BootLoadDeps {
    /** Authenticated fetch. Errors other than network ones should be BootAuthError. */
    fetch: (input: string, init: RequestInit) => Promise<Response>
    cache: BootSegmentCache | null
    subtle: SubtleCrypto
    now?: () => number
    maxTotal?: number
    maxCacheInFlightBytes?: number
    maxVerifyInFlightBytes?: number
}

// ── Stream reading ──────────────────────────────────────────────────────────

const EMPTY = new Uint8Array(0)

/** Pull-based reader over the response body that copies straight into targets. */
export class BootStreamReader {
    private chunk: Uint8Array = EMPTY
    private pos = 0

    constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

    private async pull(): Promise<boolean> {
        while (this.pos >= this.chunk.length) {
            let result: ReadableStreamReadResult<Uint8Array>
            try {
                result = await this.reader.read()
            } catch (error) {
                throw new BootFallback('stream', 'the response body failed', { cause: error })
            }
            if (result.done) return false
            const value = result.value
            this.chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike)
            this.pos = 0
        }
        return true
    }

    async readInto(target: Uint8Array, offset: number, length: number): Promise<void> {
        let filled = 0
        while (filled < length) {
            if (!await this.pull()) throw new BootFallback('truncated', `the response ended ${length - filled} bytes early`)
            const n = Math.min(length - filled, this.chunk.length - this.pos)
            target.set(this.chunk.subarray(this.pos, this.pos + n), offset + filled)
            this.pos += n
            filled += n
        }
    }

    async read(length: number): Promise<Uint8Array<ArrayBuffer>> {
        const out = new Uint8Array(length)
        await this.readInto(out, 0, length)
        return out
    }

    async readU8(): Promise<number> {
        return (await this.read(1))[0]
    }

    async readU32(): Promise<number> {
        const bytes = await this.read(4)
        return new DataView(bytes.buffer).getUint32(0, false)
    }

    async atEnd(): Promise<boolean> {
        return !await this.pull()
    }

    cancel(): void {
        this.reader.cancel().catch(() => {})
    }
}

/** Parse the framed header and manifest, leaving the reader at the first included segment. */
export async function readBootManifest(
    reader: BootStreamReader,
    options: { maxTotal?: number } = {},
): Promise<BootManifest> {
    const maxTotal = options.maxTotal ?? DEFAULT_MAX_TOTAL
    const head = await reader.read(5)
    for (let i = 0; i < MAGIC.length; i++) {
        if (head[i] !== MAGIC[i]) throw new BootFallback('protocol', 'bad magic')
    }
    const flags = head[4]
    if (flags & ~FLAG_KEY_PRESENT) throw new BootFallback('protocol', `unknown flags ${flags}`)

    let keyId: string | null = null
    let key: Uint8Array<ArrayBuffer> | null = null
    if (flags & FLAG_KEY_PRESENT) {
        const idBytes = await reader.read(await reader.readU8())
        keyId = ''
        for (const byte of idBytes) {
            if (byte < 0x20 || byte > 0x7e) throw new BootFallback('protocol', 'key id is not printable ascii')
            keyId += String.fromCharCode(byte)
        }
        const keyLength = await reader.readU8()
        if (keyLength !== KEY_BYTES) throw new BootFallback('protocol', `key length ${keyLength}`)
        key = await reader.read(KEY_BYTES)
    }

    const prefixLength = await reader.readU32()
    if (prefixLength > MAX_PREFIX_BYTES) throw new BootFallback('protocol', `prefix length ${prefixLength}`)
    const prefix = await reader.read(prefixLength)
    const count = await reader.readU32()
    if (count > MAX_SEGMENTS) throw new BootFallback('protocol', `segment count ${count}`)

    const table = await reader.read(count * MANIFEST_ENTRY_BYTES)
    const view = new DataView(table.buffer)
    const digests = new Uint8Array(count * BOOT_DIGEST_BYTES)
    const lens = new Uint32Array(count)
    const included = new Uint8Array(count)
    let total = prefixLength
    let includedBytes = 0
    for (let i = 0; i < count; i++) {
        const at = i * MANIFEST_ENTRY_BYTES
        digests.set(table.subarray(at, at + BOOT_DIGEST_BYTES), i * BOOT_DIGEST_BYTES)
        const len = view.getUint32(at + BOOT_DIGEST_BYTES, false)
        const flag = table[at + BOOT_DIGEST_BYTES + 4]
        if (flag > 1) throw new BootFallback('protocol', `included flag ${flag}`)
        lens[i] = len
        included[i] = flag
        total += len
        if (flag) includedBytes += len
    }
    if (total > maxTotal) throw new BootFallback('too-large', `${total} bytes`)
    return { keyId, key, prefix, digests, lens, included, total, includedBytes }
}

// ── Verification ────────────────────────────────────────────────────────────

/** `m1-` + the first 40 hex characters of sha256(0x01 ‖ prefix ‖ Σ(digest ‖ u32be(len))). */
export async function merkleEtag(
    prefix: Uint8Array,
    digests: Uint8Array,
    lens: Uint32Array,
    subtle: SubtleCrypto,
): Promise<string> {
    const count = lens.length
    const input = new Uint8Array(1 + prefix.length + count * (BOOT_DIGEST_BYTES + 4))
    const view = new DataView(input.buffer)
    input[0] = 0x01
    input.set(prefix, 1)
    let at = 1 + prefix.length
    for (let i = 0; i < count; i++) {
        input.set(digests.subarray(i * BOOT_DIGEST_BYTES, (i + 1) * BOOT_DIGEST_BYTES), at)
        view.setUint32(at + BOOT_DIGEST_BYTES, lens[i], false)
        at += BOOT_DIGEST_BYTES + 4
    }
    const hash = new Uint8Array(await subtle.digest('SHA-256', input))
    return `m1-${toHex(hash).slice(0, 40)}`
}

async function verifySegment(subtle: SubtleCrypto, bytes: Uint8Array<ArrayBuffer>, digests: Uint8Array, index: number): Promise<void> {
    const hash = new Uint8Array(await subtle.digest('SHA-256', bytes))
    const base = index * BOOT_DIGEST_BYTES
    for (let k = 0; k < BOOT_DIGEST_BYTES; k++) {
        if (hash[k] !== digests[base + k]) throw new BootFallback('digest', `segment ${index} does not match its digest`)
    }
}

/**
 * Runs async tasks with a bound on the bytes they hold. A task larger than the
 * bound still runs, alone.
 */
class BoundedPool {
    private bytes = 0
    private active = new Set<Promise<void>>()
    private waiters: Array<() => void> = []
    error: unknown = null

    constructor(
        private readonly maxBytes: number,
        private readonly onError: (error: unknown) => void,
        private readonly maxTasks = MAX_PARALLEL_TASKS,
    ) {}

    async run(bytes: number, task: () => Promise<void>): Promise<void> {
        while (this.error === null && this.active.size > 0
            && (this.bytes + bytes > this.maxBytes || this.active.size >= this.maxTasks)) {
            await new Promise<void>((resolve) => this.waiters.push(resolve))
        }
        if (this.error !== null) return
        this.bytes += bytes
        const running: Promise<void> = task()
            .catch((error) => this.onError(error))
            .finally(() => {
                this.bytes -= bytes
                this.active.delete(running)
                for (const wake of this.waiters.splice(0)) wake()
            })
        this.active.add(running)
    }

    /** Stop admitting tasks; waiting callers return. */
    fail(error: unknown): void {
        if (this.error === null) this.error = error
        for (const wake of this.waiters.splice(0)) wake()
    }

    async drain(): Promise<void> {
        while (this.active.size > 0) await Promise.all([...this.active])
    }
}

export type ReadCachedBatch = (batch: Array<{ index: number, digest: Uint8Array, len: number }>) => Promise<Uint8Array[]>

/**
 * Build database.bin into one preallocated buffer: the prefix, the included
 * segments straight from the stream, and the rest from `readCached`, with
 * every segment checked against its digest. Cached reads run alongside the
 * download, holding at most `maxCacheInFlightBytes`.
 */
export async function assemble(options: {
    manifest: BootManifest
    reader: BootStreamReader
    readCached: ReadCachedBatch | null
    subtle: SubtleCrypto
    maxCacheInFlightBytes?: number
    maxVerifyInFlightBytes?: number
}): Promise<Uint8Array<ArrayBuffer>> {
    const { manifest, reader, readCached, subtle } = options
    const { digests, lens, included } = manifest
    const count = lens.length
    const out = new Uint8Array(manifest.total)
    out.set(manifest.prefix, 0)
    const offsets = new Float64Array(count)
    let at = manifest.prefix.length
    for (let i = 0; i < count; i++) {
        offsets[i] = at
        at += lens[i]
    }

    // The first failure stops both loops and the download.
    let firstError: unknown = null
    const failed = () => firstError
    const failAll = (error: unknown) => {
        if (firstError !== null) return
        firstError = error
        cachePool.fail(error)
        verifyPool.fail(error)
        reader.cancel()
    }
    const cachePool = new BoundedPool(options.maxCacheInFlightBytes ?? DEFAULT_MAX_CACHE_IN_FLIGHT, failAll)
    const verifyPool = new BoundedPool(options.maxVerifyInFlightBytes ?? DEFAULT_MAX_VERIFY_IN_FLIGHT, failAll)

    const readFromCache = async () => {
        let batch: Array<{ index: number, digest: Uint8Array, len: number }> = []
        let batchBytes = 0
        const submit = async () => {
            const jobs = batch
            // Ciphertext and plaintext are both held while a batch decrypts.
            const bytes = batchBytes * 2
            batch = []
            batchBytes = 0
            await cachePool.run(bytes, async () => {
                if (!readCached) throw new BootFallback('cache-miss', 'segments omitted without a cache')
                const plains = await readCached(jobs)
                for (let j = 0; j < jobs.length; j++) {
                    const { index, len } = jobs[j]
                    const plain = plains[j]
                    if (!plain || plain.length !== len) throw new BootFallback('cache-miss', `segment ${index} unavailable`)
                    out.set(plain, offsets[index])
                    // Kept in v1 on top of AES-GCM's authentication.
                    await verifySegment(subtle, out.subarray(offsets[index], offsets[index] + len), digests, index)
                }
            })
        }
        for (let i = 0; i < count && failed() === null; i++) {
            if (included[i]) continue
            batch.push({ index: i, digest: digests.subarray(i * BOOT_DIGEST_BYTES, (i + 1) * BOOT_DIGEST_BYTES), len: lens[i] })
            batchBytes += lens[i]
            if (batchBytes >= MAX_CACHE_BATCH_BYTES || batch.length >= MAX_CACHE_BATCH_COUNT) await submit()
        }
        if (batch.length > 0 && failed() === null) await submit()
    }

    const readFromNetwork = async () => {
        for (let i = 0; i < count && failed() === null; i++) {
            if (!included[i]) continue
            const offset = offsets[i]
            const len = lens[i]
            await reader.readInto(out, offset, len)
            await verifyPool.run(len, () => verifySegment(subtle, out.subarray(offset, offset + len), digests, i))
        }
        if (failed() === null && !await reader.atEnd()) {
            throw new BootFallback('protocol', 'bytes after the last segment')
        }
    }

    const loops = [readFromCache(), readFromNetwork()].map((loop) => loop.catch((error) => {
        failAll(error)
    }))
    await Promise.all(loops)
    await Promise.all([cachePool.drain(), verifyPool.drain()])
    const error = failed()
    if (error !== null) {
        throw error instanceof BootFallback ? error : new BootFallback('assemble', String(error), { cause: error })
    }
    return out
}

// ── Loader ──────────────────────────────────────────────────────────────────

function numberHeader(response: Response, name: string): number | null {
    const raw = response.headers.get(name)
    if (raw === null || raw.trim() === '') return null
    const value = Number(raw)
    return Number.isSafeInteger(value) && value >= 0 ? value : NaN
}

function readCursor(response: Response): { instanceId: string, seq: number } | null {
    const instanceId = response.headers.get('x-sync-instance')
    const seq = Number(response.headers.get('x-sync-seq'))
    return instanceId && Number.isInteger(seq) && seq >= 0 ? { instanceId, seq } : null
}

function unquoteEtag(value: string | null): string | null {
    if (!value) return null
    return value.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1')
}

/** The digests to offer: the committed state's, deduplicated and capped. */
function haveList(state: BootCacheState | null): { body: Uint8Array<ArrayBuffer>, held: Set<string> } {
    const held = new Set<string>()
    if (!state) return { body: new Uint8Array(0), held }
    const count = state.lens.length
    const body = new Uint8Array(Math.min(count, MAX_HAVE_DIGESTS) * BOOT_DIGEST_BYTES)
    let written = 0
    for (let i = 0; i < count && held.size < MAX_HAVE_DIGESTS; i++) {
        const hex = digestHexAt(state.digests, i)
        if (held.has(hex)) continue
        held.add(hex)
        body.set(state.digests.subarray(i * BOOT_DIGEST_BYTES, (i + 1) * BOOT_DIGEST_BYTES), written * BOOT_DIGEST_BYTES)
        written++
    }
    return { body: body.subarray(0, written * BOOT_DIGEST_BYTES), held }
}

async function discardBody(response: Response): Promise<void> {
    try { await response.body?.cancel() } catch { /* already closed */ }
}

/**
 * Load database.bin through POST /api/db/boot. Resolves with the verified
 * bytes (null for 204) and the headers the legacy read would have set.
 * Throws BootFallback when the legacy /api/read must be used instead, and
 * BootAuthError for authentication failures.
 */
export async function loadDatabaseViaBoot(deps: BootLoadDeps): Promise<BootLoadResult> {
    const now = deps.now ?? (() => performance.now())
    const started = now()
    const { cache, subtle } = deps

    let state: BootCacheState | null = null
    if (cache) {
        try {
            state = await cache.loadState()
        } catch (error) {
            // An unreadable cache only costs the delta; the commit rebuilds it.
            console.warn('[Boot] Segment cache state unreadable:', error)
        }
    }
    const have = haveList(state)

    let response: Response
    try {
        response = await deps.fetch(BOOT_ENDPOINT, {
            method: 'POST',
            cache: 'no-store',
            headers: {
                'content-type': 'application/octet-stream',
                'x-boot-protocol': BOOT_PROTOCOL_VERSION,
                'x-boot-cache': '1',
                'x-boot-cache-key-id': state?.keyId ?? '',
            },
            body: have.body,
        })
    } catch (error) {
        if (error instanceof BootAuthError || error instanceof BootFallback) throw error
        throw new BootFallback('network', String(error), { cause: error })
    }

    const clearRequested = response.headers.get('x-boot-cache-clear') === '1'
    const clearCache = async () => {
        if (!clearRequested || !cache) return
        try { await cache.clear() } catch (error) { console.warn('[Boot] Clearing the segment cache failed:', error) }
    }
    const etag = unquoteEtag(response.headers.get('x-db-etag'))
    const cursor = readCursor(response)
    const dbHash = response.headers.get('x-db-hash')?.trim().toLowerCase() || null

    if (response.status === 401 || response.status === 403) {
        throw new BootAuthError({ response })
    }
    if (response.status === 204) {
        await clearCache()
        return { bytes: null, etag, cursor, dbHash, commit: null, stats: null }
    }
    if (response.status !== 200) {
        await discardBody(response)
        await clearCache()
        const reason = response.status === 404 || response.status === 503 ? 'unavailable' : `http-${response.status}`
        throw new BootFallback(reason, `HTTP ${response.status}`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (response.headers.get('x-boot-protocol') !== BOOT_PROTOCOL_VERSION || !contentType.startsWith(BOOT_CONTENT_TYPE) || !response.body) {
        await discardBody(response)
        throw new BootFallback('protocol', 'not a protocol 1 boot response')
    }
    if (!etag) {
        await discardBody(response)
        throw new BootFallback('protocol', 'no x-db-etag')
    }

    const reader = new BootStreamReader(response.body.getReader())
    let manifest: BootManifest
    let bytes: Uint8Array<ArrayBuffer>
    let key: CryptoKey | null = null
    let cachedSegments = 0
    const headerTotal = numberHeader(response, 'x-boot-total')
    const headerIncluded = numberHeader(response, 'x-boot-included')
    try {
        manifest = await readBootManifest(reader, { maxTotal: deps.maxTotal })
        if (headerTotal !== null && headerTotal !== manifest.total) {
            throw new BootFallback('total', `x-boot-total ${headerTotal} != manifest ${manifest.total}`)
        }
        if (headerIncluded !== null && headerIncluded !== manifest.includedBytes) {
            throw new BootFallback('total', `x-boot-included ${headerIncluded} != manifest ${manifest.includedBytes}`)
        }
        // Checked before any segment is read: a wrong manifest costs nothing more.
        const computed = await merkleEtag(manifest.prefix, manifest.digests, manifest.lens, subtle)
        if (computed !== etag) throw new BootFallback('merkle', 'manifest does not match x-db-etag')

        const count = manifest.lens.length
        for (let i = 0; i < count; i++) {
            if (manifest.included[i]) continue
            cachedSegments++
            if (!have.held.has(digestHexAt(manifest.digests, i))) {
                throw new BootFallback('omitted', `segment ${i} omitted but not offered`)
            }
        }
        if (cachedSegments > 0 && (!cache || !manifest.key || manifest.keyId !== state?.keyId)) {
            throw new BootFallback('key', 'omitted segments cannot be decrypted')
        }
        if (manifest.key) {
            key = await importBootCacheKey(subtle, manifest.key)
            manifest.key.fill(0)
        }

        const cryptoKey = key
        const readCached: ReadCachedBatch | null = cache && cryptoKey
            ? async (batch) => {
                const records = await cache.getSegments(batch.map((job) => job.digest))
                return Promise.all(batch.map(async (job, j) => {
                    const record = records[j]
                    if (!record) throw new BootFallback('cache-miss', `segment ${job.index} is not cached`)
                    try {
                        return await decryptSegment(subtle, cryptoKey, job.digest, job.len, record)
                    } catch (error) {
                        throw new BootFallback('cache-corrupt', `segment ${job.index} failed to decrypt`, { cause: error })
                    }
                }))
            }
            : null
        bytes = await assemble({
            manifest,
            reader,
            readCached,
            subtle,
            maxCacheInFlightBytes: deps.maxCacheInFlightBytes,
            maxVerifyInFlightBytes: deps.maxVerifyInFlightBytes,
        })
    } catch (error) {
        reader.cancel()
        if (error instanceof BootFallback) throw error
        throw new BootFallback('assemble', String(error), { cause: error })
    }

    await clearCache()
    const commit = cache && key && manifest.keyId !== null && !clearRequested
        ? commitFor(cache, subtle, key, manifest, etag, bytes)
        : null
    return {
        bytes,
        etag,
        cursor,
        dbHash,
        commit,
        stats: {
            total: manifest.total,
            includedBytes: manifest.includedBytes,
            segments: manifest.lens.length,
            networkSegments: manifest.lens.length - cachedSegments,
            cachedSegments,
            headerTotal,
            headerIncluded,
            ms: Math.round(now() - started),
        },
    }
}

/**
 * The background commit for this boot. It needs only the downloaded
 * segments; a typical boot's are copied out so the payload itself can be
 * released after the decode.
 */
function commitFor(
    cache: BootSegmentCache,
    subtle: SubtleCrypto,
    key: CryptoKey,
    manifest: BootManifest,
    etag: string,
    bytes: Uint8Array<ArrayBuffer>,
): () => Promise<BootCacheCommitResult> {
    let source: SegmentSource | null = downloadedSegments(manifest, bytes)
    const { prefix, digests, lens, total } = manifest
    const keyId = manifest.keyId as string
    return async () => {
        const bytesFor = source
        source = null
        if (!bytesFor) throw new Error('boot cache commit already ran')
        return cache.commit({ subtle, key, keyId, etag, prefix, digests, lens, total, bytesFor })
    }
}

type SegmentSource = (hex: string) => Uint8Array | null

// Kept apart from commitFor so that no closure the commit keeps shares a
// scope with the payload: only the view source may hold on to it.
function downloadedSegments(manifest: BootManifest, bytes: Uint8Array<ArrayBuffer>): SegmentSource {
    const { digests, lens, included } = manifest
    const located = new Map<string, [number, number]>()
    let at = manifest.prefix.length
    for (let i = 0; i < lens.length; i++) {
        if (included[i]) located.set(digestHexAt(digests, i), [at, lens[i]])
        at += lens[i]
    }
    return manifest.includedBytes <= COMMIT_COPY_LIMIT ? copiedSource(located, bytes) : viewSource(located, bytes)
}

function copiedSource(located: Map<string, [number, number]>, bytes: Uint8Array<ArrayBuffer>): SegmentSource {
    const copies = new Map<string, Uint8Array>()
    for (const [hex, [offset, len]] of located) copies.set(hex, bytes.slice(offset, offset + len))
    return (hex) => copies.get(hex) ?? null
}

// A first fill (or a large change): the commit keeps the payload itself
// until it has run rather than a second copy of it.
function viewSource(located: Map<string, [number, number]>, bytes: Uint8Array<ArrayBuffer>): SegmentSource {
    return (hex) => {
        const place = located.get(hex)
        return place ? bytes.subarray(place[0], place[0] + place[1]) : null
    }
}
