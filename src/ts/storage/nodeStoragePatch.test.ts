import { describe, expect, test, vi } from 'vitest'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))
vi.mock('./database.svelte', () => ({ normalizeChat: (value: any) => value }))

const { NodeStorage } = await import('./nodeStorage')

function storageReturning(status: number, body: any) {
    const storage = Object.create(NodeStorage.prototype) as InstanceType<typeof NodeStorage>
    ;(storage as any)._lastDbEtag = null
    ;(storage as any).authFetch = vi.fn(async () => new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    }))
    return storage
}

describe('NodeStorage.patchItem 409 contract', () => {
    test('marks an ordinary hash 409 as a rebase conflict', async () => {
        const storage = storageReturning(409, {
            error: 'Hash mismatch - data out of sync',
            currentEtag: 'remote-etag',
        })
        const result = await storage.patchItem('database/database.bin', {
            patch: [],
            expectedHash: 'old-hash',
        })
        expect(result).toMatchObject({
            success: false,
            etag: 'remote-etag',
            conflict: true,
            chatGuardRejected: false,
        })
        expect((storage as any)._lastDbEtag).toBe('remote-etag')
    })

    test('keeps chat-guard 409 distinct from a hash conflict', async () => {
        const storage = storageReturning(409, {
            error: 'Patch rejected: chat-internal field ops not allowed',
            code: 'CHAT_GUARD_REJECTED',
            chatGuardRejected: true,
            currentEtag: 'guard-etag',
        })
        const result = await storage.patchItem('database/database.bin', {
            patch: [{ op: 'remove', path: '/characters/0/chats/0/message' }],
            expectedHash: 'hash',
        })
        expect(result).toMatchObject({
            success: false,
            conflict: false,
            chatGuardRejected: true,
        })
    })
})
