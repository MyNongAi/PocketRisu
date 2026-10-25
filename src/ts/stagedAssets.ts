// The browser half of server/node/import-staging.cjs.
//
// For a staged import the server already stored every asset of the file and
// sent the file with each asset replaced by a stub, `PRSTAGE1:<nonce>:<ref>`,
// so a phone on mobile data receives the card, not the pictures (the user's
// request, 2026-10-25). The usual importer runs on that file; when it saves a
// stub, saveAsset asks stagedAssetRef and gets the stored reference back
// instead of uploading anything. Only stubs carrying the nonce of an import
// that is running count, and the nonce is random per response, so a file
// cannot make up references of its own.

const STUB_PREFIX = 'PRSTAGE1:'
const NONCE_RE = /^[0-9a-f]{32}$/
// What saveAsset itself returns: an external store URI or the internal key.
const REF_RE = /^(?:external:\/\/[a-z0-9._-]{1,64}\/[0-9a-f]{64}|assets\/[0-9a-f]{64}\.png)$/
// A stub is under 200 bytes; the largest thing one hides in is a PNG card's
// profile picture leftover (signature, one private chunk, IEND).
const MAX_CARRIER_BYTES = 1024

const active = new Map<string, number>()

export function isStagingNonce(value: unknown): value is string {
    return typeof value === 'string' && NONCE_RE.test(value)
}

/** Runs `work` with the stubs of `nonce` accepted by saveAsset. */
export async function withStagedAssets<T>(nonce: string, work: () => Promise<T>): Promise<T> {
    if (!isStagingNonce(nonce)) throw new Error('Invalid staging nonce')
    active.set(nonce, (active.get(nonce) ?? 0) + 1)
    try {
        return await work()
    } finally {
        const left = (active.get(nonce) ?? 1) - 1
        if (left > 0) active.set(nonce, left)
        else active.delete(nonce)
    }
}

/** The stored reference a stub of a running staged import names, if `data` is one. */
export function stagedAssetRef(data: Uint8Array): string | undefined {
    if (active.size === 0 || !(data instanceof Uint8Array)) return undefined
    if (data.byteLength < STUB_PREFIX.length + 34 || data.byteLength > MAX_CARRIER_BYTES) return undefined
    let text = ''
    for (let i = 0; i < data.byteLength; i++) text += String.fromCharCode(data[i])
    for (const nonce of active.keys()) {
        const marker = `${STUB_PREFIX}${nonce}:`
        const start = text.indexOf(marker)
        if (start < 0) continue
        const end = text.indexOf('\n', start + marker.length)
        if (end < 0) continue
        const ref = text.slice(start + marker.length, end)
        if (REF_RE.test(ref)) return ref
    }
    return undefined
}
