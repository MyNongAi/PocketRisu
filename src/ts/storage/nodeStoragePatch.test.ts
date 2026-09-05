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
    ;(storage as any).chatEtags = new Map()
    ;(storage as any).chatLeaseHeartbeats = new Map()
    ;(storage as any).chatOperations = new Map()
    ;(storage as any).authFetch = vi.fn(async () => new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    }))
    return storage
}

describe('NodeStorage per-chat optimistic concurrency', () => {
    test('a rejected claim cannot authorize overwriting the peer on retry', async () => {
        const storage = storageReturning(409, { code: 'CHAT_VERSION_CONFLICT', currentEtag: 'peer-v2' })
        ;(storage as any).chatEtags.set('char-a/chat-a', 'local-v1')
        await expect(storage.claimChatWriterSession('char-a', 'chat-a')).resolves.toMatchObject({ ok: false, reason: 'conflict' })
        await expect(storage.saveChatContent('char-a', 0, 'chat-a', { id: 'chat-a', message: [] })).rejects.toMatchObject({ name: 'ConflictError' })
        expect((storage as any).authFetch.mock.calls[1][1].headers['x-if-match']).toBe('local-v1')
    })

    test('a delayed heartbeat cannot rewind a newer save acknowledgement', async () => {
        vi.useFakeTimers()
        const storage = storageReturning(200, { ok: true, etag: 'v1' })
        try {
            ;(storage as any).chatEtags.set('char-a/chat-a', 'v1')
            await storage.claimChatWriterSession('char-a', 'chat-a')
            let finishHeartbeat!: (response: Response) => void
            const heartbeat = new Promise<Response>(resolve => { finishHeartbeat = resolve })
            const transport = (storage as any).authFetch
            transport.mockImplementationOnce(() => heartbeat)
            await vi.advanceTimersByTimeAsync(45_000)
            transport.mockResolvedValueOnce(new Response(JSON.stringify({ etag: 'v2' })))
            await storage.saveChatContent('char-a', 0, 'chat-a', { id: 'chat-a', message: [] })
            finishHeartbeat(new Response(JSON.stringify({ etag: 'v1' })))
            await vi.advanceTimersByTimeAsync(0)
            transport.mockResolvedValueOnce(new Response(JSON.stringify({ etag: 'v3' })))
            await storage.saveChatContent('char-a', 0, 'chat-a', { id: 'chat-a', message: [] })
            expect(transport.mock.calls[3][1].headers['x-if-match']).toBe('v2')
        } finally {
            await storage.releaseChatWriterSession('char-a', 'chat-a')
            vi.useRealTimers()
        }
    })

    test('same-chat saves are ordered, while another chat stays independent', async () => {
        const storage = storageReturning(200, { etag: 'saved' })
        ;(storage as any).chatEtags.set('char-a/chat-a', 'v1')
        ;(storage as any).chatEtags.set('char-a/chat-b', 'b1')
        let finishSave!: (response: Response) => void
        const pending = new Promise<Response>(resolve => { finishSave = resolve })
        const transport = (storage as any).authFetch
        transport.mockImplementationOnce(() => pending)
        const first = storage.saveChatContent('char-a', 0, 'chat-a', { id: 'chat-a', message: [] })
        const second = storage.saveChatContent('char-a', 0, 'chat-a', { id: 'chat-a', message: [] })
        await storage.saveChatContent('char-a', 1, 'chat-b', { id: 'chat-b', message: [] })
        expect(transport).toHaveBeenCalledTimes(2)
        finishSave(new Response(JSON.stringify({ etag: 'v2' })))
        await Promise.all([first, second])
        expect(transport.mock.calls[2][1].headers['x-if-match']).toBe('v2')
    })

    test('missing-payload repair keeps the surviving baseline for its recovery save', async () => {
        vi.useFakeTimers()
        const storage = storageReturning(200, { ok: true, etag: null, repairMissingPayload: true })
        try {
            ;(storage as any).chatEtags.set('char-a/chat-a', 'surviving-baseline')
            await storage.claimChatWriterSession('char-a', 'chat-a')
            ;(storage as any).authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ etag: 'repaired' })))
            await storage.saveChatContent('char-a', 0, 'chat-a', { id: 'chat-a', message: [] })
            expect((storage as any).authFetch.mock.calls[1][1].headers['x-if-match']).toBe('surviving-baseline')
        } finally {
            await storage.releaseChatWriterSession('char-a', 'chat-a')
            vi.useRealTimers()
        }
    })

    test('a claim waits for its own pending save before checking the version', async () => {
        vi.useFakeTimers()
        const storage = storageReturning(200, { ok: true, etag: 'v2' })
        try {
            ;(storage as any).chatEtags.set('char-a/chat-a', 'v1')
            let finish!: (response: Response) => void
            const pending = new Promise<Response>(resolve => { finish = resolve })
            ;(storage as any).authFetch.mockImplementationOnce(() => pending)
            const saving = storage.saveChatContent('char-a', 0, 'chat-a', { id: 'chat-a', message: [] })
            const claiming = storage.claimChatWriterSession('char-a', 'chat-a')
            await vi.advanceTimersByTimeAsync(0)
            expect((storage as any).authFetch).toHaveBeenCalledTimes(1)
            finish(new Response(JSON.stringify({ etag: 'v2' })))
            await saving
            await expect(claiming).resolves.toMatchObject({ ok: true })
            expect((storage as any).authFetch.mock.calls[1][1].headers['x-chat-etag']).toBe('v2')
        } finally {
            await storage.releaseChatWriterSession('char-a', 'chat-a')
            vi.useRealTimers()
        }
    })

    test('claims only the requested chat with its hydrated version', async () => {
        vi.useFakeTimers()
        const storage = storageReturning(200, { ok: true, etag: 'chat-v1' })
        ;(storage as any).chatEtags.set('char-a/chat-a', 'chat-v1')

        await expect(storage.claimChatWriterSession('char-a', 'chat-a')).resolves.toEqual({ ok: true })

        expect((storage as any).authFetch).toHaveBeenCalledWith(
            '/api/chat-session/char-a/chat-a/claim',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'x-chat-etag': 'chat-v1' }),
            }),
        )
        await storage.releaseChatWriterSession('char-a', 'chat-a')
        vi.useRealTimers()
    })

    test('a busy same-chat lease fails without changing the cached version', async () => {
        const storage = storageReturning(409, { code: 'CHAT_BUSY' })
        ;(storage as any).chatEtags.set('char-a/chat-a', 'chat-v1')

        await expect(storage.claimChatWriterSession('char-a', 'chat-a')).resolves.toMatchObject({
            ok: false,
            reason: 'busy',
        })
        expect((storage as any).chatEtags.get('char-a/chat-a')).toBe('chat-v1')
    })

    test('sends the hydrated chat ETag and advances it after a save', async () => {
        const storage = storageReturning(200, { success: true, etag: 'chat-v2' })
        ;(storage as any).chatEtags.set('char-a/chat-a', 'chat-v1')

        await storage.saveChatContent('char-a', 0, 'chat-a', { id: 'chat-a', message: [] })

        expect((storage as any).authFetch).toHaveBeenCalledWith(
            '/api/chat-content/char-a/0',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'x-chat-id': 'chat-a',
                    'x-if-match': 'chat-v1',
                }),
            }),
        )
        expect((storage as any).chatEtags.get('char-a/chat-a')).toBe('chat-v2')
    })

    test('creates a new chat with an explicit collision precondition', async () => {
        const storage = storageReturning(200, { success: true, etag: 'chat-v1' })

        await storage.saveChatContent(
            'char-new',
            0,
            'chat-new',
            { id: 'chat-new', message: [] },
            'create',
        )

        const [, init] = (storage as any).authFetch.mock.calls[0]
        expect(init.headers).toMatchObject({
            'x-chat-id': 'chat-new',
            'if-none-match': '*',
        })
        expect(init.headers).not.toHaveProperty('x-if-match')
    })

    test('surfaces a same-chat conflict instead of overwriting it', async () => {
        const storage = storageReturning(409, {
            error: 'Chat changed on another device',
            currentEtag: 'remote-chat-v2',
        })
        ;(storage as any).chatEtags.set('char-a/chat-a', 'chat-v1')

        await expect(storage.saveChatContent('char-a', 0, 'chat-a', { id: 'chat-a', message: [] }))
            .rejects.toMatchObject({ name: 'ConflictError', currentEtag: 'remote-chat-v2' })
    })
})

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

describe('NodeStorage asset doctor contract', () => {
    test('starts a read-only diagnosis with bounded sample options', async () => {
        const storage = storageReturning(202, {
            job: { id: 'doctor-1', status: 'queued', progress: { phase: 'queued', current: 0, total: 0 } },
        })
        await expect(storage.startAssetDiagnosis({ sampleLimit: 8, maxSampleBytes: 1024 })).resolves.toMatchObject({
            id: 'doctor-1',
            status: 'queued',
        })
        expect((storage as any).authFetch).toHaveBeenCalledWith('/api/external-assets/doctor/scan', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ sampleLimit: 8, maxSampleBytes: 1024 }),
        }))
    })

    test('requires the explicit repair endpoint payload from the client', async () => {
        const storage = storageReturning(200, {
            ok: true,
            repair: { id: 'repair-1', status: 'completed', repaired: 1, failed: 0, results: [] },
        })
        await storage.repairAssetDiagnosis('doctor/unsafe', ['issue-a'])
        expect((storage as any).authFetch).toHaveBeenCalledWith(
            '/api/external-assets/doctor/jobs/doctor%2Funsafe/repair',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ confirmed: true, issueIds: ['issue-a'] }),
            }),
        )
    })
})
