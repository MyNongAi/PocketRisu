import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))

vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(async () => ({ message: [] })),
    encodeRisuSaveLegacy: vi.fn(() => new Uint8Array([1, 2, 3])),
}))

vi.mock('./database.svelte', () => ({
    normalizeChat: (chat: any) => chat,
}))

const { NodeStorage, ConflictError } = await import('./nodeStorage')
const risuSave = await import('./risuSave')

const CHA = 'char-1'
const CHAT = 'chat-1'
const SAVE_URL = `/api/chat-content/${CHA}/0`
const msg = (role: string, data: string, chatId: string) => ({ role, data, chatId })
const LOCAL = { id: CHAT, message: [msg('user', 'a', '1'), msg('char', 'b', '2'), msg('user', 'typed here', '3')] }
const BASE = { count: 2, fp: 'fp-2' }

function jsonResponse(status: number, body: any = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function setUpStorage(fetchMock: ReturnType<typeof vi.fn>, etag: string | null = 'etag-loaded') {
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null
    const storage = new NodeStorage(fetchMock as any, { baseDelayMs: 0, delay: vi.fn(async () => {}), random: () => 1 })
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    if (etag) (storage as any).chatEtags.set((storage as any).chatEtagKey(CHA, CHAT), etag)
    return storage
}

const posts = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls
    .filter(([url, init]) => String(url).includes(SAVE_URL) && init?.method === 'POST')
    .map(([, init]) => ({
        ifMatch: init.headers.get('x-if-match'),
        ifNoneMatch: init.headers.get('if-none-match'),
        baseCount: init.headers.get('x-chat-base-count'),
        baseFp: init.headers.get('x-chat-base-fp'),
    }))

describe('delta chat saves keep the chat version precondition', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    test('a delta save carries x-if-match and the base, and advances the etag', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { etag: 'etag-next' }))
        const storage = setUpStorage(fetchMock)
        await expect(storage.saveChatContentDelta(CHA, 0, CHAT, { ...LOCAL, message: LOCAL.message.slice(2) }, BASE)).resolves.toBe('ok')
        expect(posts(fetchMock)).toEqual([{ ifMatch: 'etag-loaded', ifNoneMatch: null, baseCount: '2', baseFp: 'fp-2' }])
        expect(storage.getChatEtag(CHA, CHAT)).toBe('etag-next')
    })

    test('a version conflict on a delta asks for a full save instead of overwriting', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(409, { error: 'Chat changed on another device', currentEtag: 'etag-server' }))
        const storage = setUpStorage(fetchMock)
        await expect(storage.saveChatContentDelta(CHA, 0, CHAT, LOCAL, BASE)).resolves.toBe('base-mismatch')
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(storage.getChatEtag(CHA, CHAT)).toBe('etag-loaded')
    })

    test('an unverifiable base asks for a full save', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(409, { code: 'CHAT_DELTA_BASE_MISMATCH' }))
        const storage = setUpStorage(fetchMock)
        await expect(storage.saveChatContentDelta(CHA, 0, CHAT, LOCAL, BASE)).resolves.toBe('base-mismatch')
    })

    test('a busy chat still throws so the save retries later', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(409, { code: 'CHAT_BUSY' }))
        const storage = setUpStorage(fetchMock)
        await expect(storage.saveChatContentDelta(CHA, 0, CHAT, LOCAL, BASE)).rejects.toBeInstanceOf(ConflictError)
    })

    test('without a known version no delta is sent', async () => {
        const fetchMock = vi.fn()
        const storage = setUpStorage(fetchMock, null)
        await expect(storage.saveChatContentDelta(CHA, 0, CHAT, LOCAL, BASE)).resolves.toBe('base-mismatch')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    test('the full fallback keeps the server copy when it holds messages this device lacks', async () => {
        const server = { id: CHAT, name: 'Chat 1', message: [msg('user', 'a', '1'), msg('user', 'typed on phone', '9')] }
        vi.mocked(risuSave.decodeRisuSave).mockResolvedValueOnce(server as any)
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(409, { error: 'Chat changed on another device', currentEtag: 'etag-server' }))
            .mockResolvedValueOnce(new Response(new Uint8Array([9]), { status: 200, headers: { 'x-chat-etag': 'etag-server' } }))
            .mockResolvedValueOnce(jsonResponse(200, { etag: 'etag-next' }))
        const preserveServerCopy = vi.fn(async () => {})
        const storage = setUpStorage(fetchMock)
        await expect(storage.saveChatContentDelta(CHA, 0, CHAT, LOCAL, null, 'update', { preserveServerCopy })).resolves.toBe('ok')
        expect(preserveServerCopy).toHaveBeenCalledWith(server)
        expect(posts(fetchMock).map(p => p.ifMatch)).toEqual(['etag-loaded', 'etag-server'])
        expect(posts(fetchMock).every(p => p.baseCount === null)).toBe(true)
    })

    test('a delta GET records the whole-chat etag, never the delta body ETag', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(new Uint8Array([9]), { status: 200, headers: { 'x-chat-delta-base': '2', 'etag': 'bytes-etag', 'x-chat-etag': 'chat-etag' } }))
            .mockResolvedValueOnce(new Response(new Uint8Array([9]), { status: 200, headers: { 'x-chat-delta-base': '2', 'etag': 'bytes-etag-2' } }))
        const storage = setUpStorage(fetchMock, null)
        await expect(storage.fetchChatContentDelta(CHA, 0, CHAT, BASE)).resolves.toMatchObject({ deltaBase: 2 })
        expect(storage.getChatEtag(CHA, CHAT)).toBe('chat-etag')
        await storage.fetchChatContentDelta(CHA, 0, CHAT, BASE)
        expect(storage.getChatEtag(CHA, CHAT)).toBe('chat-etag')
    })
})
