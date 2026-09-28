// Test-side encoder for POST /api/db/boot (protocol v1), written from the
// protocol description rather than from bootPayload.ts, with node:crypto
// instead of WebCrypto so the two sides do not share an implementation.
import { createHash } from 'node:crypto'

export interface WirePlan {
    prefix: Uint8Array
    segments: Uint8Array[]
    digests: Uint8Array[]
    total: number
    etag: string
    /** What GET /api/read would return: prefix ‖ segments. */
    payload: Uint8Array
}

export const TEST_KEY_ID = 'k1a2b3c4d5e6f7a8'
export const TEST_KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)

const encoder = new TextEncoder()

export function bytesOf(text: string): Uint8Array {
    return encoder.encode(text)
}

export function sha16(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(createHash('sha256').update(bytes).digest()).slice(0, 16)
}

export function hexOf(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('hex')
}

function u32be(value: number): Uint8Array {
    const out = new Uint8Array(4)
    new DataView(out.buffer).setUint32(0, value, false)
    return out
}

export function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let at = 0
    for (const part of parts) {
        out.set(part, at)
        at += part.length
    }
    return out
}

/** A plan as the server would build it for these segments. */
export function planOf(prefix: Uint8Array, segments: Uint8Array[]): WirePlan {
    const digests = segments.map(sha16)
    const merkle = createHash('sha256')
    merkle.update(Uint8Array.of(0x01))
    merkle.update(prefix)
    for (let i = 0; i < segments.length; i++) {
        merkle.update(digests[i])
        merkle.update(u32be(segments[i].length))
    }
    return {
        prefix,
        segments,
        digests,
        total: prefix.length + segments.reduce((sum, segment) => sum + segment.length, 0),
        etag: `m1-${merkle.digest('hex').slice(0, 40)}`,
        payload: concat([prefix, ...segments]),
    }
}

/** A root-map-like prefix and `count` segments of assorted sizes. */
export function samplePlan(count = 12, seed = 1): WirePlan {
    const prefix = concat([bytesOf('RISUSAVE\0\x07\x00'), Uint8Array.of(0xde, 0x00, count)])
    const segments: Uint8Array[] = []
    for (let i = 0; i < count; i++) {
        const size = 1 + ((i * 7919 + seed * 104729) % 3000)
        segments.push(Uint8Array.from({ length: size }, (_, j) => (i * 31 + j * 17 + seed) & 0xff))
    }
    return planOf(prefix, segments)
}

export interface EncodeOptions {
    /** Hex digests the client offered; the server omits those segments. */
    have?: Set<string>
    key?: { id: string, bytes: Uint8Array } | null
    /** Replace the bytes sent for segment i (the manifest keeps the real digest). */
    tamper?: (index: number, bytes: Uint8Array) => Uint8Array
}

/** The framed response body. */
export function encodeBootBody(plan: WirePlan, options: EncodeOptions = {}): Uint8Array {
    const have = options.have ?? new Set<string>()
    const key = options.key === undefined ? { id: TEST_KEY_ID, bytes: TEST_KEY } : options.key
    const parts: Uint8Array[] = [bytesOf('PRB1'), Uint8Array.of(key ? 1 : 0)]
    if (key) parts.push(Uint8Array.of(key.id.length), bytesOf(key.id), Uint8Array.of(32), key.bytes)
    parts.push(u32be(plan.prefix.length), plan.prefix, u32be(plan.segments.length))
    const included = plan.digests.map((digest) => !have.has(hexOf(digest)))
    for (let i = 0; i < plan.segments.length; i++) {
        parts.push(plan.digests[i], u32be(plan.segments[i].length), Uint8Array.of(included[i] ? 1 : 0))
    }
    for (let i = 0; i < plan.segments.length; i++) {
        if (!included[i]) continue
        parts.push(options.tamper ? options.tamper(i, plan.segments[i]) : plan.segments[i])
    }
    return concat(parts)
}

export function includedBytes(plan: WirePlan, have: Set<string> = new Set()): number {
    let sum = 0
    for (let i = 0; i < plan.segments.length; i++) {
        if (!have.has(hexOf(plan.digests[i]))) sum += plan.segments[i].length
    }
    return sum
}

export interface ResponseOptions {
    status?: number
    headers?: Record<string, string | null>
    /** Deliver the body in chunks of this size (odd sizes cross every boundary). */
    chunkSize?: number
    /** Error the stream after this many bytes. */
    failAfter?: number
    /** Stop the stream after this many bytes, cleanly. */
    truncateAt?: number
}

export function bootResponse(body: Uint8Array, plan: WirePlan | null, options: ResponseOptions = {}): Response {
    const chunkSize = options.chunkSize ?? 7
    const end = Math.min(body.length, options.truncateAt ?? body.length)
    let at = 0
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (options.failAfter !== undefined && at >= options.failAfter) {
                controller.error(new TypeError('network connection lost'))
                return
            }
            if (at >= end) {
                controller.close()
                return
            }
            const next = Math.min(end, at + chunkSize, options.failAfter ?? Infinity)
            controller.enqueue(body.slice(at, next))
            at = next
        },
    })
    const headers: Record<string, string> = {
        'content-type': 'application/x-pocketrisu-boot',
        'cache-control': 'no-store',
        'x-boot-protocol': '1',
        'x-sync-instance': 'inst-1',
        'x-sync-seq': '42',
        'x-db-hash': 'b81a7509',
    }
    if (plan) {
        headers['x-db-etag'] = plan.etag
        headers['x-boot-total'] = String(plan.total)
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) {
        if (value === null) delete headers[name]
        else headers[name] = value
    }
    return new Response(stream, { status: options.status ?? 200, headers })
}

/** The digests a have-list request body carries, as hex. */
export function haveListOf(body: BodyInit | null | undefined): string[] {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(0)
    const out: string[] = []
    for (let i = 0; i + 16 <= bytes.length; i += 16) out.push(hexOf(bytes.subarray(i, i + 16)))
    return out
}
