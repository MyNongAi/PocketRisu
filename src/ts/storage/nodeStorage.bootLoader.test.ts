import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))

vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))

vi.mock('./database.svelte', () => ({
    normalizeChat: (chat: any) => chat,
}))

const { NodeStorage, StorageRequestError } = await import('./nodeStorage')
const { BootCacheController, MemoryBootSegmentCache } = await import('./bootPayloadCache')
const {
    TEST_KEY_ID,
    bootResponse,
    bytesOf,
    concat,
    encodeBootBody,
    haveListOf,
    hexOf,
    planOf,
    samplePlan,
} = await import('./__bootPayloadTestFixtures')
type WirePlan = import('./__bootPayloadTestFixtures').WirePlan
type BootCacheEnv = import('./bootPayloadCache').BootCacheEnv

const DB_KEY = 'database/database.bin'
const LEGACY_BYTES = Uint8Array.from([9, 8, 7, 6])

function memoryStore() {
    const map = new Map<string, string>()
    return {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => { map.set(key, value) },
        removeItem: (key: string) => { map.delete(key) },
    }
}

type Route = (init: RequestInit) => Response | Promise<Response>

function setUp(options: { boot?: Route, env?: Partial<BootCacheEnv>, cache?: InstanceType<typeof MemoryBootSegmentCache> } = {}) {
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null
    const cache = options.cache ?? new MemoryBootSegmentCache()
    const scheduled: Array<{ fn: () => void, ms: number }> = []
    const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
        if (input === '/api/db/boot') {
            if (!options.boot) throw new Error('unexpected boot request')
            return options.boot(init)
        }
        if (input === '/api/read') {
            return new Response(LEGACY_BYTES, {
                status: 200,
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-db-etag': 'm1-legacy',
                    'x-sync-instance': 'inst-legacy',
                    'x-sync-seq': '5',
                    'x-db-hash': 'ABCDEF01',
                },
            })
        }
        throw new Error(`unexpected request ${input}`)
    })
    const storage = new NodeStorage(fetchMock as any, { baseDelayMs: 0, delay: vi.fn(async () => {}), random: () => 1 })
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    const env: BootCacheEnv = {
        subtle: globalThis.crypto.subtle,
        hasIndexedDB: true,
        hasLocks: true,
        hostname: 'phone.example.ts.net',
        local: memoryStore(),
        session: memoryStore(),
        createCache: () => cache,
        schedule: (fn, ms) => {
            const entry = { fn, ms }
            scheduled.push(entry)
            return () => { scheduled.splice(scheduled.indexOf(entry), 1) }
        },
        log: () => {},
        ...options.env,
    }
    storage.bootCache = new BootCacheController(env)
    const calls = () => fetchMock.mock.calls.map(([input, init]) => ({ input, init: init as RequestInit }))
    return { storage, fetchMock, cache, scheduled, calls, env }
}

function serve(plan: WirePlan, extra: Record<string, string | null> = {}): Route {
    return (init) => {
        const keyId = new Headers(init.headers).get('x-boot-cache-key-id')
        const have = keyId === TEST_KEY_ID ? new Set(haveListOf(init.body as BodyInit)) : new Set<string>()
        return bootResponse(encodeBootBody(plan, { have }), plan, { headers: extra })
    }
}

function legacyReads(calls: ReturnType<ReturnType<typeof setUp>['calls']>) {
    return calls.filter((call) => call.input === '/api/read')
}

describe('NodeStorage database.bin through the delta boot', () => {
    afterEach(() => { vi.restoreAllMocks() })

    test('boot headers set the etag, sync cursor and server hash', async () => {
        const plan = samplePlan(12)
        const { storage, calls, scheduled } = setUp({ boot: serve(plan, { 'x-db-hash': 'B81A7509' }) })

        const data = await storage.getItem(DB_KEY)

        expect(new Uint8Array(data)).toEqual(plan.payload)
        expect(Buffer.isBuffer(data)).toBe(true)
        expect(storage._lastDbEtag).toBe(plan.etag)
        expect(storage.syncCursor).toEqual({ instanceId: 'inst-1', seq: 42 })
        expect(storage.lastBootDbHash).toBe('b81a7509')
        expect(storage.lastDbLoad).toMatchObject({ mode: 'boot', total: plan.total, segments: 12, cachedSegments: 0, fallbackReason: null })
        expect(legacyReads(calls())).toHaveLength(0)
        const boot = calls()[0]
        expect(new Headers(boot.init.headers).get('risu-auth')).toBe('token')
        // The commit waits for boot to settle.
        expect(scheduled).toHaveLength(1)
        expect(scheduled[0].ms).toBe(4000)
    })

    test('the next boot sends the committed digests and downloads only changes', async () => {
        const first = samplePlan(12)
        const cache = new MemoryBootSegmentCache()
        const one = setUp({ boot: serve(first), cache })
        await one.storage.getItem(DB_KEY)
        one.scheduled[0].fn()
        await vi.waitFor(() => expect(cache.state?.etag).toBe(first.etag))

        const next = planOf(first.prefix, first.segments.map((s, i) => i === 5 ? concat([s, bytesOf('x')]) : s))
        const two = setUp({ boot: serve(next), cache })
        const data = await two.storage.getItem(DB_KEY)
        expect(new Uint8Array(data)).toEqual(next.payload)
        expect(two.storage.lastDbLoad).toMatchObject({ mode: 'boot', cachedSegments: 11, received: next.segments[5].length })
        const body = two.calls()[0].init.body as BodyInit
        expect(haveListOf(body).sort()).toEqual(first.digests.map(hexOf).sort())
    })

    test('204 returns null like an empty read', async () => {
        const { storage, calls } = setUp({ boot: () => new Response(null, { status: 204, headers: { 'x-sync-instance': 'i', 'x-sync-seq': '0' } }) })
        expect(await storage.getItem(DB_KEY)).toBeNull()
        expect(storage.syncCursor).toEqual({ instanceId: 'i', seq: 0 })
        expect(legacyReads(calls())).toHaveLength(0)
    })

    const fallbacks: Array<[string, () => Route]> = [
        ['404 (old server)', () => () => new Response('Cannot POST /api/db/boot', { status: 404 })],
        ['503 (planner disabled)', () => () => new Response('{"error":"BOOT_DISABLED"}', { status: 503 })],
        ['500', () => () => new Response('{"error":"boom"}', { status: 500 })],
        ['a network error in the middle of the body', () => {
            const plan = samplePlan(12)
            const body = encodeBootBody(plan)
            return () => bootResponse(body, plan, { failAfter: body.length - 50 })
        }],
        ['a network failure before any response', () => () => { throw new TypeError('Failed to fetch') }],
        ['a Merkle mismatch', () => serve(samplePlan(12), { 'x-db-etag': 'm1-0000' })],
    ]

    test.each(fallbacks)('%s falls back to /api/read without the HTTP cache', async (_label, route) => {
        const { storage, calls } = setUp({ boot: route() })
        const data = await storage.getItem(DB_KEY)
        expect(new Uint8Array(data)).toEqual(LEGACY_BYTES)
        const reads = legacyReads(calls())
        expect(reads).toHaveLength(1)
        expect(reads[0].init.cache).toBe('no-store')
        expect(storage._lastDbEtag).toBe('m1-legacy')
        expect(storage.syncCursor).toEqual({ instanceId: 'inst-legacy', seq: 5 })
        expect(storage.lastBootDbHash).toBe('abcdef01')
        expect(storage.lastDbLoad).toMatchObject({ mode: 'read', total: 4 })
        expect(storage.lastDbLoad?.fallbackReason).toBeTruthy()
    })

    test('503 is not retried as a transient error', async () => {
        const { storage, calls } = setUp({ boot: () => new Response('{}', { status: 503 }) })
        await storage.getItem(DB_KEY)
        expect(calls().filter((call) => call.input === '/api/db/boot')).toHaveLength(1)
    })

    test('a cache miss falls back', async () => {
        const plan = samplePlan(8)
        const cache = new MemoryBootSegmentCache()
        const one = setUp({ boot: serve(plan), cache })
        await one.storage.getItem(DB_KEY)
        one.scheduled[0].fn()
        await vi.waitFor(() => expect(cache.state?.etag).toBe(plan.etag))
        cache.segments.delete(hexOf(plan.digests[3]))

        const two = setUp({ boot: serve(plan), cache })
        expect(new Uint8Array(await two.storage.getItem(DB_KEY))).toEqual(LEGACY_BYTES)
        expect(two.storage.lastDbLoad?.fallbackReason).toBe('cache-miss')
    })

    test('two consecutive fallbacks suspend the cache for the session', async () => {
        const { storage, calls, env } = setUp({ boot: () => new Response('', { status: 404 }) })
        await storage.getItem(DB_KEY)
        await storage.getItem(DB_KEY)
        expect(storage.bootCache.suspendedReason()).toBe('fallbacks (unavailable)')
        await storage.getItem(DB_KEY)
        expect(calls().filter((call) => call.input === '/api/db/boot')).toHaveLength(2)
        // Only the delta boot is suspended; a new session tries again.
        expect(new BootCacheController({ ...env, session: memoryStore() }).usable()).toBe(true)
    })

    test('401 propagates as the legacy read would, without a legacy read', async () => {
        const { storage, calls } = setUp({ boot: () => new Response('{"error":"Unauthorized"}', { status: 401 }) })
        const error = await storage.getItem(DB_KEY).then(() => null, (e) => e)
        expect(error).toBeInstanceOf(StorageRequestError)
        expect(error.status).toBe(401)
        expect(legacyReads(calls())).toHaveLength(0)
        expect(storage.bootCache.suspendedReason()).toBeNull()
    })

    test('a failed login propagates', async () => {
        const { storage, calls } = setUp({ boot: serve(samplePlan(3)) })
        const loginError = new Error('Node login failed')
        vi.spyOn(storage as any, 'checkAuth').mockRejectedValue(loginError)
        await expect(storage.getItem(DB_KEY)).rejects.toBe(loginError)
        expect(calls()).toHaveLength(0)
    })

    test.each([
        ['a loopback host', { hostname: '127.0.0.1' }],
        ['localhost', { hostname: 'localhost' }],
        ['no WebCrypto (insecure context)', { subtle: null }],
        ['no IndexedDB', { hasIndexedDB: false }],
        ['no Web Locks', { hasLocks: false }],
    ] as Array<[string, Partial<BootCacheEnv>]>)('%s skips the loader and keeps the plain read', async (_label, env) => {
        const { storage, calls } = setUp({ boot: serve(samplePlan(3)), env })
        expect(new Uint8Array(await storage.getItem(DB_KEY))).toEqual(LEGACY_BYTES)
        expect(calls().map((call) => call.input)).toEqual(['/api/read'])
        expect(calls()[0].init.cache).toBeUndefined()
        expect(storage.lastBootDbHash).toBe('abcdef01')
        expect(storage.lastDbLoad).toMatchObject({ mode: 'read', fallbackReason: null })
    })

    test("localStorage 'off' skips the loader", async () => {
        const local = memoryStore()
        local.setItem('risu-boot-cache', 'off')
        const { storage, calls } = setUp({ boot: serve(samplePlan(3)), env: { local } })
        await storage.getItem(DB_KEY)
        expect(calls().map((call) => call.input)).toEqual(['/api/read'])
    })

    test('other keys never use the loader', async () => {
        const { storage, calls } = setUp({ boot: serve(samplePlan(3)) })
        await storage.getItem('database/dbbackup-1.bin')
        expect(calls().map((call) => call.input)).toEqual(['/api/read'])
        expect(storage.lastDbLoad).toBeNull()
        expect(storage.lastBootDbHash).toBeNull()
    })
})
