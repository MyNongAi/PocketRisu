import { describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    fetchChatContentDelta: vi.fn(),
    saveChatContentDelta: vi.fn(),
    saveChatContent: vi.fn(),
}))
vi.mock('../globalApi.svelte', () => ({
    forageStorage: {
        realStorage: {
            fetchChatContentDelta: (...args: any[]) => mocks.fetchChatContentDelta(...args),
            saveChatContentDelta: (...args: any[]) => mocks.saveChatContentDelta(...args),
            saveChatContent: (...args: any[]) => mocks.saveChatContent(...args),
        },
    },
}))
vi.mock('./database.svelte', () => ({
    isChatStub: () => false,
}))

const { saveChatToServer, ensureChatHydrated } = await import('./chatStorage')

const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ role: 'user', data: `m${i}`, chatId: `c${i}` }))

describe('saveChatToServer through delta sync', () => {
    test('a create bypasses delta sync with its intent and options', async () => {
        const options = { preserveServerCopy: vi.fn() }
        const chat: any = { id: 'x', message: msgs(3) }
        await saveChatToServer('cha', 0, 'x', chat, 'create', options)
        expect(mocks.saveChatContent).toHaveBeenCalledWith('cha', 0, 'x', chat, 'create', options)
        expect(mocks.saveChatContentDelta).not.toHaveBeenCalled()
    })

    test('the full fallback after a refused delta receives the caller options', async () => {
        const chat: any = { id: 'y', message: msgs(50) }
        mocks.fetchChatContentDelta.mockResolvedValueOnce({ chat: { id: 'y', message: msgs(50) }, deltaBase: null })
        const chats: any[] = [{ id: 'y', _placeholder: true, message: [] }]
        await ensureChatHydrated(chats, 0, 'cha')
        const options = { preserveServerCopy: vi.fn() }
        chat.message.push({ role: 'char', data: 'new', chatId: 'new' })
        mocks.saveChatContentDelta
            .mockResolvedValueOnce('base-mismatch')
            .mockResolvedValueOnce('ok')
        await saveChatToServer('cha', 0, 'y', chat, 'update', options)
        const calls = mocks.saveChatContentDelta.mock.calls
        expect(calls).toHaveLength(2)
        expect(calls[0][4]).toMatchObject({ count: 50 })
        expect(calls[0][3].message).toHaveLength(1)
        expect(calls[1][3]).toBe(chat)
        expect(calls[1][4]).toBeNull()
        expect(calls[1][5]).toBe('update')
        expect(calls[1][6]).toBe(options)
    })
})
