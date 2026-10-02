import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn(() => new Uint8Array([1])) }))
vi.mock('./database.svelte', () => ({ normalizeChat: (chat: any) => chat }))
vi.mock('./buildFence', async (importOriginal) => ({
    ...await importOriginal<typeof import('./buildFence')>(),
    reportStaleBuild: vi.fn(),
}))

const { NodeStorage, StorageRequestError } = await import('./nodeStorage')
const { BUILD_ID_HEADER, StaleBuildError, reportStaleBuild, setClientBuildIdForTests } = await import('./buildFence')

function jsonResponse(status: number, body: any = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function staleRefusal() {
    return jsonResponse(426, { error: 'older build', code: 'STALE_CLIENT_BUILD', serverBuild: 'new-build' })
}

function setUpStorage(fetchMock: ReturnType<typeof vi.fn>) {
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null
    const storage = new NodeStorage(fetchMock as any, { baseDelayMs: 0, delay: vi.fn(async () => {}), random: () => 1 })
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    return storage
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>, call = 0): Headers {
    return new Headers(fetchMock.mock.calls[call][1].headers)
}

describe('NodeStorage build fence', () => {
    beforeEach(() => {
        vi.mocked(reportStaleBuild).mockClear()
        setClientBuildIdForTests('old-build')
    })

    afterEach(() => {
        setClientBuildIdForTests('')
    })

    test('every storage request carries the build id', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(200, { etag: 'e1' }))
            .mockResolvedValueOnce(jsonResponse(200, { content: [] }))
        const storage = setUpStorage(fetchMock)
        await storage.setItem('database/database.bin', new Uint8Array([1]))
        await storage.keys('drafts/')
        expect(sentHeaders(fetchMock, 0).get(BUILD_ID_HEADER)).toBe('old-build')
        expect(sentHeaders(fetchMock, 1).get(BUILD_ID_HEADER)).toBe('old-build')
    })

    test('a dev build sends no build id', async () => {
        setClientBuildIdForTests('')
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { etag: 'e1' }))
        const storage = setUpStorage(fetchMock)
        await storage.setItem('database/database.bin', new Uint8Array([1]))
        expect(sentHeaders(fetchMock).has(BUILD_ID_HEADER)).toBe(false)
    })

    test('a refused patch throws instead of falling back, and is reported once', async () => {
        const fetchMock = vi.fn().mockResolvedValue(staleRefusal())
        const storage = setUpStorage(fetchMock)
        const result = storage.patchItem('database/database.bin', { patch: [], expectedHash: 'x' })
        await expect(result).rejects.toBeInstanceOf(StaleBuildError)
        await expect(result).rejects.toMatchObject({ serverBuildId: 'new-build', status: 426 })
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(reportStaleBuild).toHaveBeenCalledExactlyOnceWith('new-build')
    })

    test('a refused asset write does not retry through internal storage', async () => {
        const fetchMock = vi.fn().mockResolvedValue(staleRefusal())
        const storage = setUpStorage(fetchMock)
        await expect(storage.setItem('assets/a.png', new Uint8Array([1]))).rejects.toBeInstanceOf(StaleBuildError)
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(String(fetchMock.mock.calls[0][0])).toBe('/api/external-assets/write')
    })

    test('a refused chat claim says why instead of blaming the connection', async () => {
        const fetchMock = vi.fn().mockResolvedValue(staleRefusal())
        const storage = setUpStorage(fetchMock)
        const claim = await storage.claimChatWriterSession('c1', 'chat1')
        expect(claim).toMatchObject({ ok: false, reason: 'rejected' })
        expect((claim as { message?: string }).message).toBe(new StaleBuildError('new-build').message)
    })

    test('a 426 without the stale-build code is an ordinary error', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('Upgrade Required', { status: 426 }))
        const storage = setUpStorage(fetchMock)
        await expect(storage.setItem('database/database.bin', new Uint8Array([1]))).rejects.toBeInstanceOf(StorageRequestError)
        expect(reportStaleBuild).not.toHaveBeenCalled()
    })
})
