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

const { NodeStorage } = await import('./nodeStorage')
const risuSave = await import('./risuSave')

const CHA = 'char-1'
const CHAT = 'chat-1'
const SAVE_URL = `/api/chat-content/${CHA}/0`

const msg = (role: string, data: string, chatId: string) => ({ role, data, chatId })
const LOCAL = { id: CHAT, message: [msg('user', 'a', '1'), msg('char', 'b', '2'), msg('user', 'typed here', '3')] }

function jsonResponse(status: number, body: any = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function chatBody(etag: string) {
    return new Response(new Uint8Array([9, 9]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'x-chat-etag': etag },
    })
}

function setUpStorage(fetchMock: ReturnType<typeof vi.fn>) {
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null
    const storage = new NodeStorage(fetchMock as any, { baseDelayMs: 0, delay: vi.fn(async () => {}), random: () => 1 })
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    // A baseline this device loaded earlier.
    ;(storage as any).chatEtags.set((storage as any).chatEtagKey(CHA, CHAT), 'etag-loaded')
    return storage
}

const posts = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls
    .filter(([url, init]) => String(url).includes(SAVE_URL) && init?.method === 'POST')
    .map(([, init]) => ({ ifMatch: init.headers.get('x-if-match'), ifNoneMatch: init.headers.get('if-none-match') }))

describe('saveChatContent when another device changed the chat', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    test('overwrites directly when this copy holds every server message', async () => {
        vi.mocked(risuSave.decodeRisuSave).mockResolvedValueOnce({ message: LOCAL.message.slice(0, 2) } as any)
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(409, { error: 'Chat changed on another device', currentEtag: 'etag-server' }))
            .mockResolvedValueOnce(chatBody('etag-server'))
            .mockResolvedValueOnce(jsonResponse(200, { etag: 'etag-next' }))
        const preserveServerCopy = vi.fn(async () => {})
        const storage = setUpStorage(fetchMock)

        await storage.saveChatContent(CHA, 0, CHAT, LOCAL, 'update', { preserveServerCopy })

        expect(preserveServerCopy).not.toHaveBeenCalled()
        expect(posts(fetchMock)).toEqual([
            { ifMatch: 'etag-loaded', ifNoneMatch: null },
            { ifMatch: 'etag-server', ifNoneMatch: null }, // still conditional
        ])
    })

    test('keeps the server copy first when it holds messages this device lacks', async () => {
        const server = { id: CHAT, name: 'Chat 1', message: [msg('user', 'a', '1'), msg('user', 'typed on phone', '9')] }
        vi.mocked(risuSave.decodeRisuSave).mockResolvedValueOnce(server as any)
        const order: string[] = []
        const fetchMock = vi.fn(async (url: string, init: any) => {
            if (init?.method === 'POST') {
                order.push(`post:${init.headers.get('x-if-match')}`)
                return order.length === 1
                    ? jsonResponse(409, { error: 'Chat changed on another device', currentEtag: 'etag-server' })
                    : jsonResponse(200, { etag: 'etag-next' })
            }
            order.push('get')
            return chatBody('etag-server')
        })
        const preserveServerCopy = vi.fn(async (serverChat: any) => { order.push(`copy:${serverChat.message.length}`) })
        const storage = setUpStorage(fetchMock)

        await storage.saveChatContent(CHA, 0, CHAT, LOCAL, 'update', { preserveServerCopy })

        expect(preserveServerCopy).toHaveBeenCalledWith(server)
        expect(order).toEqual(['post:etag-loaded', 'get', 'copy:2', 'post:etag-server'])
    })

    test('without a way to keep the server copy, a lossy overwrite is refused as before', async () => {
        vi.mocked(risuSave.decodeRisuSave).mockResolvedValueOnce({ message: [msg('user', 'typed on phone', '9')] } as any)
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(409, { error: 'Chat changed on another device', currentEtag: 'etag-server' }))
            .mockResolvedValueOnce(chatBody('etag-server'))
        const storage = setUpStorage(fetchMock)

        await expect(storage.saveChatContent(CHA, 0, CHAT, LOCAL, 'update')).rejects.toThrow('Chat changed on another device')
        expect(posts(fetchMock)).toHaveLength(1)
    })

    test('a chat deleted on another device is saved back', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(409, { error: 'Chat no longer exists on the server', currentEtag: null }))
            .mockResolvedValueOnce(jsonResponse(404, { error: 'Chat not found' }))
            .mockResolvedValueOnce(jsonResponse(200, { etag: 'etag-new' }))
        const storage = setUpStorage(fetchMock)

        await storage.saveChatContent(CHA, 0, CHAT, LOCAL, 'update')

        expect(posts(fetchMock).at(-1)).toEqual({ ifMatch: null, ifNoneMatch: '*' })
    })

    test('a chat generating on another device is still left to retry later', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(409, { error: 'This chat is generating on another page or device', code: 'CHAT_BUSY' }))
        const storage = setUpStorage(fetchMock)

        await expect(storage.saveChatContent(CHA, 0, CHAT, LOCAL, 'update')).rejects.toThrow('generating on another')
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test('a second conflict during the retry is reported, not looped', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(409, { error: 'Chat changed on another device', currentEtag: 'etag-server' }))
            .mockResolvedValueOnce(chatBody('etag-server'))
            .mockResolvedValueOnce(jsonResponse(409, { error: 'Chat changed on another device', currentEtag: 'etag-third' }))
        const storage = setUpStorage(fetchMock)

        await expect(storage.saveChatContent(CHA, 0, CHAT, LOCAL, 'update', { preserveServerCopy: vi.fn(async () => {}) }))
            .rejects.toThrow('Chat changed on another device')
        expect(fetchMock).toHaveBeenCalledTimes(3)
    })
})
