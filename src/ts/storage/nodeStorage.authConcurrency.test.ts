import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const { NodeStorage } = await import('./nodeStorage')

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

describe('NodeStorage authentication request coalescing', () => {
    beforeEach(() => {
        ;(NodeStorage as any).sessionInitialized = true
        ;(NodeStorage as any).sessionPending = null
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('shares one authentication check between simultaneous requests', async () => {
        const pending = deferred<Response>()
        const fetchMock = vi.fn(() => pending.promise)
        vi.stubGlobal('fetch', fetchMock)
        const storage = new NodeStorage()

        const first = (storage as any).checkAuth()
        const second = (storage as any).checkAuth()

        expect(fetchMock).toHaveBeenCalledTimes(1)
        pending.resolve(new Response(JSON.stringify({ status: 'correct', token: 'jwt' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }))

        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
        expect(storage.authChecked).toBe(true)
    })

    it('clears a failed shared check so the next request can retry', async () => {
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new TypeError('network unavailable'))
            .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'correct' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }))
        vi.stubGlobal('fetch', fetchMock)
        const storage = new NodeStorage()

        await expect((storage as any).checkAuth()).rejects.toThrow('network unavailable')
        await expect((storage as any).checkAuth()).resolves.toBeUndefined()
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })
})
