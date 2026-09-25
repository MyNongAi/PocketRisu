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

const CHA = 'char-1'
const CHAT = 'chat-1'
const SAVE_URL = `/api/chat-content/${CHA}/0`

function jsonResponse(status: number, body: any = {}, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    })
}

/** A chat body the GET baseline probe can return, with its ETag header. */
function chatBody(etag: string) {
    return new Response(new Uint8Array([9, 9]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'x-chat-etag': etag },
    })
}

function setUpStorage(fetchMock: ReturnType<typeof vi.fn>) {
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null

    const storage = new NodeStorage(fetchMock as any, {
        baseDelayMs: 0,
        delay: vi.fn(async () => {}),
        random: () => 1,
    })
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    return storage
}

/**
 * Headers the mock saw on the POST to the chat-content endpoint. authFetch
 * normalizes them into a Headers instance before calling fetch.
 */
function savePostHeaders(fetchMock: ReturnType<typeof vi.fn>) {
    const call = fetchMock.mock.calls.find(
        ([url, init]) => String(url).includes(SAVE_URL) && init?.method === 'POST',
    )
    const headers = call?.[1]?.headers
    return {
        ifNoneMatch: headers?.get?.('if-none-match') ?? undefined,
        ifMatch: headers?.get?.('x-if-match') ?? undefined,
    }
}

describe('saveChatContent when the server has no body for the chat', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    // Regression: an 'update' with no cached ETag probes the server for a
    // baseline. A 404 there used to throw "Chat was removed on another page or
    // device", which refused the save and left the only copy of the messages in
    // the tab. Nothing exists to overwrite, so the chat is written instead.
    test('saves the chat instead of refusing when the baseline probe 404s', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(404, { error: 'Chat not found' }))
            .mockResolvedValueOnce(jsonResponse(200, { etag: 'etag-new' }))
        const storage = setUpStorage(fetchMock)

        await expect(
            storage.saveChatContent(CHA, 0, CHAT, { message: [] }, 'update'),
        ).resolves.toBeUndefined()

        // Written create-only, so a peer that got there first still wins.
        const headers = savePostHeaders(fetchMock)
        expect(headers.ifNoneMatch).toBe('*')
        expect(headers.ifMatch).toBeUndefined()
    })

    // A peer created the chat between the probe and the write. The save is not
    // refused: this copy holds everything the peer's does (nothing), so it is
    // written over it, still conditionally on the peer's ETag.
    test('saves over a chat that reappears before the write lands', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(404, { error: 'Chat not found' }))
            .mockResolvedValueOnce(jsonResponse(409, { error: 'Chat already exists', currentEtag: 'etag-peer' }))
            .mockResolvedValueOnce(chatBody('etag-peer'))
            .mockResolvedValueOnce(jsonResponse(200, { etag: 'etag-next' }))
        const storage = setUpStorage(fetchMock)

        await expect(
            storage.saveChatContent(CHA, 0, CHAT, { message: [] }, 'update'),
        ).resolves.toBeUndefined()

        const posts = fetchMock.mock.calls.filter(([url, init]) => String(url).includes(SAVE_URL) && init?.method === 'POST')
        expect(posts.at(-1)?.[1]?.headers?.get?.('x-if-match')).toBe('etag-peer')
    })

    // The downgrade must not weaken the normal path: a chat the server still
    // holds has to keep its if-match precondition so a peer's newer messages
    // cannot be clobbered.
    test('still guards with x-if-match when the server does hold the chat', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(chatBody('etag-server'))
            .mockResolvedValueOnce(jsonResponse(200, { etag: 'etag-next' }))
        const storage = setUpStorage(fetchMock)

        await expect(
            storage.saveChatContent(CHA, 0, CHAT, { message: [] }, 'update'),
        ).resolves.toBeUndefined()

        const headers = savePostHeaders(fetchMock)
        expect(headers.ifMatch).toBe('etag-server')
        expect(headers.ifNoneMatch).toBeUndefined()
    })
})
