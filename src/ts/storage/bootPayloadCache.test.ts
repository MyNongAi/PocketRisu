import { afterEach, describe, expect, test, vi } from 'vitest'
import {
    BOOT_CACHE_FLAG_KEY,
    BootCacheController,
    IdbBootSegmentCache,
    MemoryBootSegmentCache,
    decryptSegment,
    encryptSegment,
    importBootCacheKey,
    isLoopbackHost,
    type BootCacheCommitArgs,
    type BootCacheEnv,
    type BootSegmentCache,
} from './bootPayloadCache'
import { loadDatabaseViaBoot } from './bootPayload'
import {
    TEST_KEY,
    TEST_KEY_ID,
    bootResponse,
    bytesOf,
    concat,
    encodeBootBody,
    haveListOf,
    hexOf,
    planOf,
    samplePlan,
    type WirePlan,
} from './__bootPayloadTestFixtures'

const subtle = globalThis.crypto.subtle

async function testKey() {
    return importBootCacheKey(subtle, TEST_KEY.slice())
}

async function commitArgs(plan: WirePlan, options: { keyId?: string, only?: Set<number> } = {}): Promise<BootCacheCommitArgs> {
    const byHex = new Map(plan.segments.map((segment, i) => [hexOf(plan.digests[i]), { segment, i }]))
    return {
        subtle,
        key: await testKey(),
        keyId: options.keyId ?? TEST_KEY_ID,
        etag: plan.etag,
        prefix: plan.prefix,
        digests: concat(plan.digests),
        lens: Uint32Array.from(plan.segments.map((segment) => segment.length)),
        total: plan.total,
        bytesFor: (hex) => {
            const hit = byHex.get(hex)
            return hit && (!options.only || options.only.has(hit.i)) ? hit.segment : null
        },
    }
}

function changed(plan: WirePlan, index: number): WirePlan {
    return planOf(plan.prefix, plan.segments.map((segment, i) => i === index ? concat([segment, bytesOf('!')]) : segment))
}

describe('segment encryption', () => {
    test('round trips, and binds each record to its digest and length', async () => {
        const key = await testKey()
        const digest = Uint8Array.from({ length: 16 }, (_, i) => i)
        const other = Uint8Array.from({ length: 16 }, (_, i) => 15 - i)
        const bytes = bytesOf('segment bytes 한국어')
        const record = await encryptSegment(subtle, key, digest, bytes)
        expect(record.len).toBe(bytes.length)
        expect(new Uint8Array(record.ct)).not.toEqual(bytes)
        expect(await decryptSegment(subtle, key, digest, bytes.length, record)).toEqual(bytes)
        await expect(decryptSegment(subtle, key, other, bytes.length, record)).rejects.toThrow()
        await expect(decryptSegment(subtle, key, digest, bytes.length + 1, { ...record, len: bytes.length + 1 })).rejects.toThrow()
        const wrongKey = await importBootCacheKey(subtle, new Uint8Array(32))
        await expect(decryptSegment(subtle, wrongKey, digest, bytes.length, record)).rejects.toThrow()
    })

    test('the imported key cannot be exported', async () => {
        const key = await testKey()
        expect(key.extractable).toBe(false)
        await expect(subtle.exportKey('raw', key)).rejects.toThrow()
    })
})

// The commit logic is shared; run it against the in-memory store and the
// IndexedDB store (over the fake below).
const stores: Array<[string, () => BootSegmentCache & { peekSegmentCount(): number }]> = [
    ['memory', () => {
        const cache = new MemoryBootSegmentCache() as MemoryBootSegmentCache & { peekSegmentCount(): number }
        cache.peekSegmentCount = () => cache.segments.size
        return cache
    }],
    ['indexeddb', () => {
        const idb = new FakeIdbFactory()
        const cache = new IdbBootSegmentCache(idb as unknown as IDBFactory, new FakeLocks()) as IdbBootSegmentCache & { peekSegmentCount(): number }
        cache.peekSegmentCount = () => idb.segmentCount()
        return cache
    }],
]

describe.each(stores)('%s segment cache', (_name, create) => {
    test('a commit writes only missing segments and collects the unreferenced ones', async () => {
        const cache = create()
        const first = samplePlan(10)
        expect(await cache.commit(await commitArgs(first))).toMatchObject({ ok: true, written: 10, deleted: 0 })
        const state = await cache.loadState()
        expect(state?.etag).toBe(first.etag)
        expect(state?.digests).toEqual(concat(first.digests))
        expect(state?.lens.length).toBe(10)

        const next = changed(first, 4)
        expect(await cache.commit(await commitArgs(next))).toMatchObject({ ok: true, written: 1, deleted: 1 })
        expect(cache.peekSegmentCount()).toBe(10)
        expect((await cache.loadState())?.etag).toBe(next.etag)

        const records = await cache.getSegments(next.digests)
        const key = await testKey()
        for (let i = 0; i < 10; i++) {
            expect(await decryptSegment(subtle, key, next.digests[i], next.segments[i].length, records[i]!)).toEqual(next.segments[i])
        }
        expect(await cache.getSegments([first.digests[4]])).toEqual([null])
        expect(await cache.stats()).toMatchObject({ segments: 10 })
    })

    test('a commit that cannot supply a segment keeps the previous state', async () => {
        const cache = create()
        const first = samplePlan(6)
        await cache.commit(await commitArgs(first))
        const next = changed(first, 2)
        const result = await cache.commit(await commitArgs(next, { only: new Set([0]) }))
        expect(result).toMatchObject({ ok: false, reason: 'segment-unavailable' })
        expect((await cache.loadState())?.etag).toBe(first.etag)
    })

    test('a different key starts from an empty store', async () => {
        const cache = create()
        const first = samplePlan(6)
        await cache.commit(await commitArgs(first))
        const result = await cache.commit(await commitArgs(first, { keyId: 'rotated' }))
        expect(result).toMatchObject({ ok: true, written: 6 })
        expect((await cache.loadState())?.keyId).toBe('rotated')
    })

    test('concurrent commits run one after the other', async () => {
        const cache = create()
        const a = samplePlan(6, 1)
        const b = samplePlan(6, 2)
        const [ra, rb] = await Promise.all([cache.commit(await commitArgs(a)), cache.commit(await commitArgs(b))])
        expect(ra).toMatchObject({ ok: true, written: 6 })
        // The second commit saw the first one's segments as present only if
        // it ran after it; either way the final state is b alone.
        expect(rb).toMatchObject({ ok: true, deleted: 6 })
        expect((await cache.loadState())?.etag).toBe(b.etag)
        expect(cache.peekSegmentCount()).toBe(6)
    })

    test('clear removes the state and every segment', async () => {
        const cache = create()
        await cache.commit(await commitArgs(samplePlan(5)))
        await cache.clear()
        expect(await cache.loadState()).toBeNull()
        expect(cache.peekSegmentCount()).toBe(0)
    })

    test('transactions stay under the size bound', async () => {
        const cache = create()
        const plan = samplePlan(20)
        const args = { ...await commitArgs(plan), maxTransactionBytes: 4000 }
        const puts = vi.spyOn(cache as any, 'putRecords')
        await cache.commit(args)
        for (const [entries] of puts.mock.calls as Array<[Array<[Uint8Array, { len: number }]>]>) {
            const bytes = entries.reduce((sum, [, record]) => sum + record.len, 0)
            const largest = Math.max(...entries.map(([, record]) => record.len))
            expect(bytes - largest).toBeLessThan(4000)
        }
        expect(puts.mock.calls.length).toBeGreaterThan(1)
    })
})

describe('MemoryBootSegmentCache', () => {
    test('an aborted final transaction keeps the old state; the next commit collects the orphans', async () => {
        const cache = new MemoryBootSegmentCache()
        const first = samplePlan(8)
        await cache.commit(await commitArgs(first))
        const next = changed(first, 1)
        cache.failNextFinalize = true
        await expect(cache.commit(await commitArgs(next))).rejects.toThrow('simulated')
        expect(cache.state?.etag).toBe(first.etag)
        expect(cache.segments.size).toBe(9)

        // A boot against the old state still works: its segments are all there.
        const again = await cache.commit(await commitArgs(first))
        expect(again).toMatchObject({ ok: true, written: 0, deleted: 1 })
        expect(cache.segments.size).toBe(8)
    })

    test('commits are serialized', async () => {
        const cache = new MemoryBootSegmentCache()
        await Promise.all([cache.commit(await commitArgs(samplePlan(3, 1))), cache.commit(await commitArgs(samplePlan(3, 2)))])
        expect(cache.ops).toEqual(['wipe', 'put:3', 'final', 'put:3', 'final'])
    })
})

describe('IdbBootSegmentCache', () => {
    test('the final transaction aborts when a segment vanished, keeping the old state', async () => {
        const idb = new FakeIdbFactory()
        const cache = new IdbBootSegmentCache(idb as unknown as IDBFactory, new FakeLocks())
        const first = samplePlan(6)
        await cache.commit(await commitArgs(first))
        const next = changed(first, 3)
        // Another writer removes a segment between the presence scan and the
        // final transaction.
        idb.beforeTransaction = (names, mode) => {
            if (mode === 'readwrite' && names.includes('state')) {
                idb.beforeTransaction = null
                idb.deleteSegment(hexOf(next.digests[0]))
            }
        }
        const result = await cache.commit(await commitArgs(next))
        expect(result).toMatchObject({ ok: false, reason: 'segment-missing-at-final' })
        expect((await cache.loadState())?.etag).toBe(first.etag)
    })

    test('a quota error while writing segments rejects and keeps the old state', async () => {
        const idb = new FakeIdbFactory()
        const cache = new IdbBootSegmentCache(idb as unknown as IDBFactory, new FakeLocks())
        const first = samplePlan(6)
        await cache.commit(await commitArgs(first))
        idb.failPuts = new DOMException('quota', 'QuotaExceededError')
        await expect(cache.commit(await commitArgs(changed(first, 0)))).rejects.toThrow('quota')
        expect((await cache.loadState())?.etag).toBe(first.etag)
        expect(idb.segmentCount()).toBe(6)
    })

    test('serves a delta boot end to end', async () => {
        const idb = new FakeIdbFactory()
        const cache = new IdbBootSegmentCache(idb as unknown as IDBFactory, new FakeLocks())
        const first = samplePlan(15)
        const serve = (plan: WirePlan) => vi.fn(async (_input: string, init: RequestInit) => {
            const keyId = new Headers(init.headers).get('x-boot-cache-key-id')
            const have = keyId === TEST_KEY_ID ? new Set(haveListOf(init.body as BodyInit)) : new Set<string>()
            return bootResponse(encodeBootBody(plan, { have }), plan)
        })
        const boot1 = await loadDatabaseViaBoot({ fetch: serve(first), cache, subtle })
        expect(boot1.bytes).toEqual(first.payload)
        await boot1.commit!()
        const next = changed(first, 9)
        const boot2 = await loadDatabaseViaBoot({ fetch: serve(next), cache, subtle })
        expect(boot2.bytes).toEqual(next.payload)
        expect(boot2.stats).toMatchObject({ networkSegments: 1, cachedSegments: 14 })
        expect(await boot2.commit!()).toMatchObject({ ok: true, written: 1, deleted: 1 })
    })
})

// ── Policy ──────────────────────────────────────────────────────────────────

function memoryStore() {
    const map = new Map<string, string>()
    return {
        map,
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => { map.set(key, value) },
        removeItem: (key: string) => { map.delete(key) },
    }
}

function testEnv(overrides: Partial<BootCacheEnv> = {}) {
    const cache = new MemoryBootSegmentCache()
    const timers: Array<{ fn: () => void, ms: number, cancelled: boolean }> = []
    const logs: string[] = []
    const env: BootCacheEnv = {
        subtle,
        hasIndexedDB: true,
        hasLocks: true,
        hostname: 'phone.example.ts.net',
        local: memoryStore(),
        session: memoryStore(),
        createCache: () => cache,
        schedule: (fn, ms) => {
            const timer = { fn, ms, cancelled: false }
            timers.push(timer)
            return () => { timer.cancelled = true }
        },
        log: (level, message) => { logs.push(`${level}:${message}`) },
        ...overrides,
    }
    const runTimers = async () => {
        for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn()
        await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return { env, cache, timers, logs, runTimers }
}

describe('BootCacheController', () => {
    afterEach(() => { vi.restoreAllMocks() })

    test('needs WebCrypto, IndexedDB, Web Locks and a non-loopback host', () => {
        expect(new BootCacheController(testEnv().env).usable()).toBe(true)
        expect(new BootCacheController(testEnv({ subtle: null }).env).usable()).toBe(false)
        expect(new BootCacheController(testEnv({ hasIndexedDB: false }).env).usable()).toBe(false)
        expect(new BootCacheController(testEnv({ hasLocks: false }).env).usable()).toBe(false)
        for (const host of ['localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST']) {
            expect(isLoopbackHost(host)).toBe(true)
            expect(new BootCacheController(testEnv({ hostname: host }).env).usable()).toBe(false)
        }
        expect(isLoopbackHost('192.168.0.10')).toBe(false)
    })

    test("the 'off' switch disables it and clears the cache once", async () => {
        const { env, cache } = testEnv()
        await cache.commit(await commitArgs(samplePlan(3)))
        env.local!.setItem(BOOT_CACHE_FLAG_KEY, 'off')
        const controller = new BootCacheController(env)
        expect(controller.usable()).toBe(false)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(cache.segments.size).toBe(0)
        expect(controller.usable()).toBe(false)
        expect(cache.ops.filter((op) => op === 'wipe')).toHaveLength(2)
    })

    test('two consecutive fallbacks suspend it for the session and clear the cache', async () => {
        const { env, cache, logs } = testEnv()
        await cache.commit(await commitArgs(samplePlan(3)))
        const controller = new BootCacheController(env)
        controller.noteFallback('merkle')
        expect(controller.usable()).toBe(true)
        controller.noteSuccess()
        controller.noteFallback('merkle')
        expect(controller.usable()).toBe(true)
        controller.noteFallback('digest')
        expect(controller.usable()).toBe(false)
        expect(controller.suspendedReason()).toBe('fallbacks (digest)')
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(cache.segments.size).toBe(0)
        expect(logs.some((line) => line.startsWith('warning:[BootCache] Suspended'))).toBe(true)
        // The suspension is per session: a new page in this tab keeps it.
        expect(new BootCacheController(env).usable()).toBe(false)
        // A new session tries again.
        expect(new BootCacheController({ ...env, session: memoryStore() }).usable()).toBe(true)
    })

    test('the fallback count survives reloads until a boot succeeds', () => {
        const { env } = testEnv()
        new BootCacheController(env).noteFallback('unavailable')
        const next = new BootCacheController(env)
        next.noteFallback('unavailable')
        expect(next.usable()).toBe(false)
    })

    test('a scheduled commit runs after the delay and logs its outcome', async () => {
        const { env, timers, logs, runTimers } = testEnv()
        const controller = new BootCacheController(env)
        const commit = vi.fn(async () => ({ ok: true, written: 2, writtenBytes: 10, deleted: 1, ms: 3 }))
        controller.scheduleCommit(commit)
        expect(timers[0].ms).toBe(4000)
        expect(commit).not.toHaveBeenCalled()
        await runTimers()
        expect(commit).toHaveBeenCalledTimes(1)
        expect(logs.some((line) => line.includes('Stored 2 new segments'))).toBe(true)
    })

    test('a commit also waits until boot has settled, and a clear while waiting cancels it', async () => {
        let settle: () => void = () => {}
        const settled = new Promise<void>((resolve) => { settle = resolve })
        const { env, runTimers } = testEnv({ whenSettled: () => settled })
        const controller = new BootCacheController(env)
        const commit = vi.fn(async () => ({ ok: true, written: 0, writtenBytes: 0, deleted: 0, ms: 0 }))
        controller.scheduleCommit(commit)
        await runTimers()
        expect(commit).not.toHaveBeenCalled()
        settle()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(commit).toHaveBeenCalledTimes(1)

        let settleSecond: () => void = () => {}
        const second = testEnv({ whenSettled: () => new Promise<void>((resolve) => { settleSecond = resolve }) })
        const cleared = new BootCacheController(second.env)
        const secondCommit = vi.fn(async () => ({ ok: true, written: 0, writtenBytes: 0, deleted: 0, ms: 0 }))
        cleared.scheduleCommit(secondCommit)
        await second.runTimers()
        await cleared.clear()
        settleSecond()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(secondCommit).not.toHaveBeenCalled()
    })

    test('suspension cancels a pending commit; a failed commit suspends', async () => {
        const first = testEnv()
        const controller = new BootCacheController(first.env)
        const commit = vi.fn(async () => ({ ok: true, written: 0, writtenBytes: 0, deleted: 0, ms: 0 }))
        controller.scheduleCommit(commit)
        controller.suspend('x-db-hash mismatch')
        await first.runTimers()
        expect(commit).not.toHaveBeenCalled()

        const second = testEnv()
        const failing = new BootCacheController(second.env)
        failing.scheduleCommit(async () => { throw new DOMException('quota', 'QuotaExceededError') })
        await second.runTimers()
        expect(failing.suspendedReason()).toBe('commit failed: QuotaExceededError')
    })

    test('status reports the cached size and state', async () => {
        const { env, cache } = testEnv()
        const plan = samplePlan(4)
        await cache.commit(await commitArgs(plan))
        const status = await new BootCacheController(env).status()
        expect(status).toMatchObject({ supported: true, userDisabled: false, suspended: null, segments: 4, cachedBytes: plan.total, etag: plan.etag })
    })
})

// ── A minimal IndexedDB for IdbBootSegmentCache ─────────────────────────────
// Requests complete asynchronously in order; a transaction commits once no
// request is pending after the last callback, and abort() discards its
// changes. Values are structured-cloned like the real store.

type StoreData = Map<string, { key: IDBValidKey, value: unknown }>

function serializeKey(key: IDBValidKey): string {
    if (key instanceof ArrayBuffer) return `b:${hexOf(new Uint8Array(key))}`
    return `s:${String(key)}`
}

class FakeRequest {
    result: any = undefined
    error: unknown = null
    onsuccess: ((event: unknown) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    onupgradeneeded: ((event: unknown) => void) | null = null
    onblocked: ((event: unknown) => void) | null = null
}

class FakeTransaction {
    private working = new Map<string, StoreData>()
    private queue: Array<() => void> = []
    private scheduled = false
    private finished = false
    error: unknown = null
    oncomplete: (() => void) | null = null
    onabort: (() => void) | null = null
    onerror: (() => void) | null = null

    constructor(private readonly db: FakeDatabase, names: string[], private readonly failPuts: unknown) {
        for (const name of names) this.working.set(name, new Map(db.stores.get(name)))
    }

    objectStore(name: string) {
        const data = this.working.get(name)!
        const request = (run: () => unknown) => {
            const req = new FakeRequest()
            this.queue.push(() => {
                req.result = run()
                req.onsuccess?.({ target: req })
            })
            this.kick()
            return req
        }
        return {
            get: (key: IDBValidKey) => request(() => structuredClone(data.get(serializeKey(key))?.value)),
            put: (value: unknown, key: IDBValidKey) => {
                if (this.failPuts && name === 'segments') {
                    this.fail(this.failPuts)
                    return new FakeRequest()
                }
                return request(() => { data.set(serializeKey(key), { key, value: structuredClone(value) }) })
            },
            delete: (key: IDBValidKey) => request(() => { data.delete(serializeKey(key)) }),
            count: (key?: IDBValidKey) => request(() => key === undefined ? data.size : (data.has(serializeKey(key)) ? 1 : 0)),
            getAllKeys: () => request(() => [...data.values()].map((entry) => entry.key)),
            clear: () => request(() => { data.clear() }),
        }
    }

    abort() {
        this.fail(null)
    }

    private fail(error: unknown) {
        if (this.finished) return
        this.finished = true
        this.queue = []
        this.error = error
        setTimeout(() => this.onabort?.(), 0)
    }

    private kick() {
        if (this.scheduled) return
        this.scheduled = true
        setTimeout(() => this.step(), 0)
    }

    private step() {
        this.scheduled = false
        if (this.finished) return
        const next = this.queue.shift()
        if (next) {
            next()
            // Requests made in the callback keep the transaction alive; with
            // none, the next step commits.
            if (!this.finished) this.kick()
            return
        }
        this.finished = true
        for (const [name, data] of this.working) this.db.stores.set(name, data)
        this.oncomplete?.()
    }
}

class FakeDatabase {
    stores = new Map<string, StoreData>()
    onversionchange: (() => void) | null = null
    onclose: (() => void) | null = null
    objectStoreNames = { contains: (name: string) => this.stores.has(name) }

    constructor(private readonly factory: FakeIdbFactory) {}

    createObjectStore(name: string) {
        this.stores.set(name, new Map())
    }

    transaction(names: string | string[], mode: 'readonly' | 'readwrite') {
        const list = Array.isArray(names) ? names : [names]
        this.factory.beforeTransaction?.(list, mode)
        return new FakeTransaction(this, list, mode === 'readwrite' ? this.factory.failPuts : null)
    }

    close() { /* nothing to release */ }
}

class FakeIdbFactory {
    private db: FakeDatabase | null = null
    failPuts: unknown = null
    beforeTransaction: ((names: string[], mode: string) => void) | null = null

    open(_name: string, _version: number) {
        const request = new FakeRequest()
        setTimeout(() => {
            const fresh = !this.db
            this.db ??= new FakeDatabase(this)
            request.result = this.db
            if (fresh) request.onupgradeneeded?.({ target: request })
            request.onsuccess?.({ target: request })
        }, 0)
        return request
    }

    segmentCount(): number {
        return this.db?.stores.get('segments')?.size ?? 0
    }

    deleteSegment(hex: string) {
        this.db?.stores.get('segments')?.delete(`b:${hex}`)
    }
}

class FakeLocks {
    private chain: Promise<unknown> = Promise.resolve()

    request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
        const run = this.chain.then(callback, callback)
        this.chain = run.catch(() => {})
        return run
    }
}
