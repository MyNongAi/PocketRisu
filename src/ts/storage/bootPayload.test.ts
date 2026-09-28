import { describe, expect, test, vi } from 'vitest'
import {
    BootAuthError,
    BootFallback,
    loadDatabaseViaBoot,
    merkleEtag,
    type BootLoadDeps,
} from './bootPayload'
import { MemoryBootSegmentCache, toHex } from './bootPayloadCache'
import {
    TEST_KEY_ID,
    bootResponse,
    bytesOf,
    concat,
    encodeBootBody,
    hexOf,
    haveListOf,
    includedBytes,
    planOf,
    samplePlan,
    type EncodeOptions,
    type ResponseOptions,
    type WirePlan,
} from './__bootPayloadTestFixtures'

const subtle = globalThis.crypto.subtle

/** A fetch that answers the boot request like the server would for `plan`. */
function serverFor(plan: WirePlan, encode: EncodeOptions = {}, response: ResponseOptions = {}) {
    const calls: Array<{ input: string, init: RequestInit }> = []
    const fetch = vi.fn(async (input: string, init: RequestInit) => {
        calls.push({ input, init })
        const offered = new Set(haveListOf(init.body as BodyInit))
        const keyId = new Headers(init.headers).get('x-boot-cache-key-id')
        const have = encode.have ?? (keyId === TEST_KEY_ID ? offered : new Set<string>())
        const body = encodeBootBody(plan, { ...encode, have })
        return bootResponse(body, plan, {
            ...response,
            headers: { 'x-boot-included': String(includedBytes(plan, have)), ...response.headers },
        })
    })
    return { fetch, calls }
}

function deps(fetch: BootLoadDeps['fetch'], cache: MemoryBootSegmentCache | null, extra: Partial<BootLoadDeps> = {}): BootLoadDeps {
    return { fetch, cache, subtle, ...extra }
}

/** Boot once from an empty cache and commit, like the first boot on a device. */
async function primedCache(plan: WirePlan) {
    const cache = new MemoryBootSegmentCache()
    const { fetch } = serverFor(plan)
    const result = await loadDatabaseViaBoot(deps(fetch, cache))
    expect(result.commit).not.toBeNull()
    const committed = await result.commit!()
    expect(committed.ok).toBe(true)
    return cache
}

/** Same prefix, segment 3 changed and one segment appended. */
function nextPlan(plan: WirePlan): WirePlan {
    const segments = plan.segments.map((segment, i) => i === 3 ? concat([segment, bytesOf('lastDate')]) : segment)
    segments.push(bytesOf('a new character'))
    return planOf(plan.prefix, segments)
}

async function expectFallback(promise: Promise<unknown>, reason: string) {
    const error = await promise.then(() => null, (e) => e)
    expect(error).toBeInstanceOf(BootFallback)
    expect((error as BootFallback).reason).toBe(reason)
}

describe('merkleEtag', () => {
    test('matches the server derivation over prefix, digests and u32be lengths', async () => {
        const plan = samplePlan(40)
        const digests = concat(plan.digests)
        const lens = Uint32Array.from(plan.segments.map((segment) => segment.length))
        expect(await merkleEtag(plan.prefix, digests, lens, subtle)).toBe(plan.etag)
        expect(plan.etag).toMatch(/^m1-[0-9a-f]{40}$/)
    })
})

describe('loadDatabaseViaBoot', () => {
    test('assembles from the network only on a first boot', async () => {
        const plan = samplePlan(30)
        const cache = new MemoryBootSegmentCache()
        const { fetch, calls } = serverFor(plan, {}, { chunkSize: 5 })

        const result = await loadDatabaseViaBoot(deps(fetch, cache))

        expect(result.bytes).toEqual(plan.payload)
        expect(result.etag).toBe(plan.etag)
        expect(result.cursor).toEqual({ instanceId: 'inst-1', seq: 42 })
        expect(result.dbHash).toBe('b81a7509')
        expect(result.stats).toMatchObject({
            total: plan.total,
            includedBytes: plan.total - plan.prefix.length,
            segments: 30,
            networkSegments: 30,
            cachedSegments: 0,
        })
        const init = calls[0].init
        expect(calls[0].input).toBe('/api/db/boot')
        expect(init.method).toBe('POST')
        expect(init.cache).toBe('no-store')
        const headers = new Headers(init.headers)
        expect(headers.get('x-boot-protocol')).toBe('1')
        expect(headers.get('x-boot-cache')).toBe('1')
        expect(headers.get('x-boot-cache-key-id')).toBe('')
        expect(headers.get('content-type')).toBe('application/octet-stream')
        expect((init.body as Uint8Array).length).toBe(0)

        const committed = await result.commit!()
        expect(committed).toMatchObject({ ok: true, written: 30, deleted: 0 })
        expect(cache.state?.etag).toBe(plan.etag)
        expect(cache.state?.keyId).toBe(TEST_KEY_ID)
        // Nothing is stored in plaintext.
        for (const record of cache.segments.values()) {
            expect(record.ct.byteLength).toBe(record.len + 16)
        }
    })

    test('assembles from the cache plus the changed segments', async () => {
        const first = samplePlan(30)
        const cache = await primedCache(first)
        const plan = nextPlan(first)
        const { fetch, calls } = serverFor(plan, {}, { chunkSize: 3 })

        const result = await loadDatabaseViaBoot(deps(fetch, cache, { maxCacheInFlightBytes: 4096 }))

        expect(result.bytes).toEqual(plan.payload)
        const headers = new Headers(calls[0].init.headers)
        expect(headers.get('x-boot-cache-key-id')).toBe(TEST_KEY_ID)
        expect(haveListOf(calls[0].init.body as BodyInit).sort()).toEqual(first.digests.map(hexOf).sort())
        expect(result.stats).toMatchObject({ segments: 31, networkSegments: 2, cachedSegments: 29 })
        expect(result.stats?.includedBytes).toBe(plan.segments[3].length + plan.segments[30].length)

        // The commit stores only the two new segments and drops the replaced one.
        const committed = await result.commit!()
        expect(committed).toMatchObject({ ok: true, written: 2, deleted: 1 })
        expect(cache.segments.size).toBe(31)
        expect(cache.state?.etag).toBe(plan.etag)
    })

    test('an unchanged boot reads every segment from the cache', async () => {
        const plan = samplePlan(20)
        const cache = await primedCache(plan)
        const { fetch } = serverFor(plan)
        const result = await loadDatabaseViaBoot(deps(fetch, cache))
        expect(result.bytes).toEqual(plan.payload)
        expect(result.stats).toMatchObject({ networkSegments: 0, cachedSegments: 20, includedBytes: 0 })
        expect(await result.commit!()).toMatchObject({ ok: true, written: 0, deleted: 0 })
    })

    test('a network segment that does not match its digest falls back', async () => {
        const plan = samplePlan(10)
        const { fetch } = serverFor(plan, {
            tamper: (i, bytes) => {
                if (i !== 6) return bytes
                const copy = bytes.slice()
                copy[0] ^= 1
                return copy
            },
        })
        await expectFallback(loadDatabaseViaBoot(deps(fetch, new MemoryBootSegmentCache())), 'digest')
    })

    test('a manifest whose Merkle root is not x-db-etag falls back before reading segments', async () => {
        const plan = samplePlan(10)
        const { fetch } = serverFor(plan, {}, { headers: { 'x-db-etag': 'm1-' + '0'.repeat(40) } })
        await expectFallback(loadDatabaseViaBoot(deps(fetch, new MemoryBootSegmentCache())), 'merkle')
    })

    test('a missing x-db-etag falls back', async () => {
        const plan = samplePlan(4)
        const { fetch } = serverFor(plan, {}, { headers: { 'x-db-etag': null } })
        await expectFallback(loadDatabaseViaBoot(deps(fetch, null)), 'protocol')
    })

    test('a truncated stream falls back', async () => {
        const plan = samplePlan(10)
        const body = encodeBootBody(plan)
        const fetch = vi.fn(async () => bootResponse(body, plan, { truncateAt: body.length - 5 }))
        await expectFallback(loadDatabaseViaBoot(deps(fetch, new MemoryBootSegmentCache())), 'truncated')
    })

    test('a stream cut inside the manifest falls back', async () => {
        const plan = samplePlan(10)
        const body = encodeBootBody(plan)
        const fetch = vi.fn(async () => bootResponse(body, plan, { truncateAt: 60 }))
        await expectFallback(loadDatabaseViaBoot(deps(fetch, null)), 'truncated')
    })

    test('a network error in the middle of the body falls back', async () => {
        const plan = samplePlan(10)
        const body = encodeBootBody(plan)
        const fetch = vi.fn(async () => bootResponse(body, plan, { failAfter: body.length - 100 }))
        await expectFallback(loadDatabaseViaBoot(deps(fetch, new MemoryBootSegmentCache())), 'stream')
    })

    test('bytes after the last segment fall back', async () => {
        const plan = samplePlan(5)
        const body = concat([encodeBootBody(plan), Uint8Array.of(0)])
        const fetch = vi.fn(async () => bootResponse(body, plan))
        await expectFallback(loadDatabaseViaBoot(deps(fetch, null)), 'protocol')
    })

    test('a total that disagrees with x-boot-total, or x-boot-included, falls back', async () => {
        const plan = samplePlan(8)
        const wrongTotal = serverFor(plan, {}, { headers: { 'x-boot-total': String(plan.total + 1) } })
        await expectFallback(loadDatabaseViaBoot(deps(wrongTotal.fetch, null)), 'total')
        const wrongIncluded = serverFor(plan, {}, { headers: { 'x-boot-included': '1' } })
        await expectFallback(loadDatabaseViaBoot(deps(wrongIncluded.fetch, null)), 'total')
    })

    test('a total over the sanity limit falls back without allocating it', async () => {
        const plan = samplePlan(8)
        const { fetch } = serverFor(plan)
        await expectFallback(loadDatabaseViaBoot(deps(fetch, null, { maxTotal: plan.total - 1 })), 'too-large')
    })

    test('a segment omitted although the client did not offer it falls back', async () => {
        const plan = samplePlan(10)
        const cache = await primedCache(samplePlan(10, 2))
        // The server claims the client holds segment 4, which it never had.
        const { fetch } = serverFor(plan, { have: new Set([hexOf(plan.digests[4])]) })
        await expectFallback(loadDatabaseViaBoot(deps(fetch, cache)), 'omitted')
    })

    test('segments omitted under a different key id fall back', async () => {
        const plan = samplePlan(10)
        const cache = await primedCache(plan)
        const fetch = vi.fn(async (_input: string, init: RequestInit) => {
            const have = new Set(haveListOf(init.body as BodyInit))
            return bootResponse(encodeBootBody(plan, { have, key: { id: 'another-key-id', bytes: new Uint8Array(32) } }), plan)
        })
        await expectFallback(loadDatabaseViaBoot(deps(fetch, cache)), 'key')
    })

    test('a cached record that fails authentication falls back', async () => {
        const plan = samplePlan(10)
        const cache = await primedCache(plan)
        const [hex, record] = [...cache.segments.entries()][2]
        const ct = new Uint8Array(record.ct.slice(0))
        ct[3] ^= 0x80
        cache.segments.set(hex, { ...record, ct: ct.buffer })
        const { fetch } = serverFor(plan)
        await expectFallback(loadDatabaseViaBoot(deps(fetch, cache)), 'cache-corrupt')
    })

    test('a record swapped onto another digest does not decrypt', async () => {
        const plan = samplePlan(10)
        const cache = await primedCache(plan)
        const a = hexOf(plan.digests[1])
        const b = hexOf(plan.digests[2])
        cache.segments.set(a, cache.segments.get(b)!)
        const { fetch } = serverFor(plan)
        await expectFallback(loadDatabaseViaBoot(deps(fetch, cache)), 'cache-corrupt')
    })

    test('a segment another tab removed from the cache falls back', async () => {
        const plan = samplePlan(10)
        const cache = await primedCache(plan)
        cache.segments.delete(hexOf(plan.digests[7]))
        const { fetch } = serverFor(plan)
        await expectFallback(loadDatabaseViaBoot(deps(fetch, cache)), 'cache-miss')
    })

    test('204 means no database yet', async () => {
        const fetch = vi.fn(async () => new Response(null, {
            status: 204,
            headers: { 'x-sync-instance': 'inst-1', 'x-sync-seq': '7' },
        }))
        const result = await loadDatabaseViaBoot(deps(fetch, new MemoryBootSegmentCache()))
        expect(result.bytes).toBeNull()
        expect(result.commit).toBeNull()
        expect(result.cursor).toEqual({ instanceId: 'inst-1', seq: 7 })
    })

    test.each([404, 503])('%i means the endpoint is unavailable', async (status) => {
        const fetch = vi.fn(async () => new Response('{"error":"BOOT_DISABLED"}', { status }))
        await expectFallback(loadDatabaseViaBoot(deps(fetch, new MemoryBootSegmentCache())), 'unavailable')
    })

    test('other statuses fall back too', async () => {
        const fetch = vi.fn(async () => new Response('oops', { status: 500 }))
        await expectFallback(loadDatabaseViaBoot(deps(fetch, null)), 'http-500')
    })

    test('x-boot-cache-clear wipes the cache', async () => {
        const plan = samplePlan(6)
        const cache = await primedCache(plan)
        expect(cache.segments.size).toBe(6)
        const fetch = vi.fn(async () => new Response(null, { status: 503, headers: { 'x-boot-cache-clear': '1' } }))
        await expectFallback(loadDatabaseViaBoot(deps(fetch, cache)), 'unavailable')
        expect(cache.segments.size).toBe(0)
        expect(cache.state).toBeNull()
    })

    test('401 and 403 are authentication errors, not fallbacks', async () => {
        for (const status of [401, 403]) {
            const response = new Response('{"error":"Unauthorized"}', { status })
            const error = await loadDatabaseViaBoot(deps(vi.fn(async () => response), null)).then(() => null, (e) => e)
            expect(error).toBeInstanceOf(BootAuthError)
            expect((error as BootAuthError).response).toBe(response)
        }
    })

    test('errors from the authenticated fetch propagate; network errors fall back', async () => {
        const auth = new BootAuthError({ cause: new Error('Node login failed') })
        await expect(loadDatabaseViaBoot(deps(vi.fn(async () => { throw auth }), null))).rejects.toBe(auth)
        await expectFallback(loadDatabaseViaBoot(deps(vi.fn(async () => { throw new TypeError('Failed to fetch') }), null)), 'network')
    })

    test('a response that is not a protocol 1 boot body falls back', async () => {
        const plan = samplePlan(3)
        const html = serverFor(plan, {}, { headers: { 'content-type': 'text/html' } })
        await expectFallback(loadDatabaseViaBoot(deps(html.fetch, null)), 'protocol')
        const v2 = serverFor(plan, {}, { headers: { 'x-boot-protocol': '2' } })
        await expectFallback(loadDatabaseViaBoot(deps(v2.fetch, null)), 'protocol')
        const badMagic = vi.fn(async () => bootResponse(concat([bytesOf('PRB2'), encodeBootBody(plan).subarray(4)]), plan))
        await expectFallback(loadDatabaseViaBoot(deps(badMagic, null)), 'protocol')
    })

    test('without a key in the response nothing is committed', async () => {
        const plan = samplePlan(6)
        const { fetch } = serverFor(plan, { key: null })
        const result = await loadDatabaseViaBoot(deps(fetch, new MemoryBootSegmentCache()))
        expect(result.bytes).toEqual(plan.payload)
        expect(result.commit).toBeNull()
    })

    test('the commit copies what it needs, so the payload can change afterwards', async () => {
        const first = samplePlan(12)
        const cache = await primedCache(first)
        const plan = nextPlan(first)
        const { fetch } = serverFor(plan)
        const result = await loadDatabaseViaBoot(deps(fetch, cache))
        result.bytes!.fill(0)
        expect(await result.commit!()).toMatchObject({ ok: true, written: 2 })
        const again = await loadDatabaseViaBoot(deps(serverFor(plan).fetch, cache))
        expect(again.bytes).toEqual(plan.payload)
        expect(again.stats?.networkSegments).toBe(0)
    })

    test('duplicate segments assemble and commit once', async () => {
        const base = samplePlan(4)
        const plan = planOf(base.prefix, [...base.segments, base.segments[1], base.segments[1]])
        const cache = new MemoryBootSegmentCache()
        const first = await loadDatabaseViaBoot(deps(serverFor(plan).fetch, cache))
        expect(first.bytes).toEqual(plan.payload)
        expect(await first.commit!()).toMatchObject({ ok: true, written: 4 })
        const { fetch, calls } = serverFor(plan)
        const second = await loadDatabaseViaBoot(deps(fetch, cache))
        expect(second.bytes).toEqual(plan.payload)
        expect(haveListOf(calls[0].init.body as BodyInit)).toHaveLength(4)
        expect(second.stats?.cachedSegments).toBe(6)
    })

    test('the raw key is not kept in the manifest after import', async () => {
        const plan = samplePlan(3)
        const importKey = vi.spyOn(subtle, 'importKey')
        try {
            await loadDatabaseViaBoot(deps(serverFor(plan).fetch, new MemoryBootSegmentCache()))
            const raw = importKey.mock.calls[0][1] as Uint8Array
            expect(toHex(raw)).toBe('0'.repeat(64))
            expect(importKey.mock.calls[0][3]).toBe(false)
        } finally {
            importKey.mockRestore()
        }
    })
})
