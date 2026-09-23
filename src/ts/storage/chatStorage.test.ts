import { beforeEach, describe, test, expect, vi } from 'vitest'

// Stub out the heavy reactive modules so loading chatStorage.ts doesn't trigger
// unrelated $effect chains that fail in a stripped-down test environment.
// Mirror the production isChatStub semantics including the hybrid guard so
// the chat-data-loss tests below exercise the real intent.
const mocks = vi.hoisted(() => ({
    fetchChatContent: vi.fn(),
}))
vi.mock('../globalApi.svelte', () => ({
    forageStorage: {
        realStorage: {
            fetchChatContent: (...args: any[]) => mocks.fetchChatContent(...args),
        },
    },
}))
vi.mock('./database.svelte', () => ({
    isChatStub: (chat: any) => chat
        && chat._stub === true
        && !Array.isArray(chat.message),
}))

const {
    chatToStub,
    stubToPlaceholder,
    convertStubsToPlaceholders,
    classifyChat,
    ensureChatHydrated,
    hydratedChatCacheSize,
    markHydratedChatDirty,
    markHydratedChatPersisted,
    evictHydratedChatCache,
    resetHydratedChatCache,
    setChatSaveRequester,
    replaceChatBody,
    rehomeHydratedChats,
    suppressChatTracking,
    isHydrating,
    isHydratedChatDirty,
} = await import('./chatStorage')
type Chat = any
type ChatStub = any

beforeEach(() => {
    resetHydratedChatCache()
    mocks.fetchChatContent.mockReset()
    mocks.fetchChatContent.mockImplementation(async (chaId: string, _index: number, chatId: string) => ({
        message: [{ role: 'char', data: `${chaId}/${chatId}` }],
        note: '',
        name: chatId,
        localLore: [],
        id: chatId,
    }))
})

// Round-trip tests for stub ↔ placeholder conversions. The server merge layer
// relies on key presence ('in' semantics) to distinguish "user cleared this
// field" from "field is absent". Both client converters must preserve key
// presence end-to-end, otherwise null clears get dropped on the way out and
// stale fullChat metadata resurfaces on the next persist.

const blankChat = (overrides: Partial<Chat> = {}): Chat => ({
    message: [],
    note: '',
    name: 'test',
    localLore: [],
    id: 'c1',
    ...overrides,
})

describe('chatToStub', () => {
    test('preserves explicit null folderId as a key', () => {
        const stub = chatToStub(blankChat({ folderId: null as any }))
        expect('folderId' in stub).toBe(true)
        expect(stub.folderId).toBeNull()
    })

    test('omits folderId when the chat has no such key', () => {
        const stub = chatToStub(blankChat())
        expect('folderId' in stub).toBe(false)
    })

    test('preserves a non-null folderId', () => {
        const stub = chatToStub(blankChat({ folderId: 'F1' }))
        expect(stub.folderId).toBe('F1')
    })

    test('same key-presence semantics applies to modules', () => {
        expect('modules' in chatToStub(blankChat({ modules: null as any }))).toBe(true)
        expect('modules' in chatToStub(blankChat({ modules: [] }))).toBe(true)
        expect('modules' in chatToStub(blankChat())).toBe(false)
    })

    test('same key-presence semantics applies to lastDate', () => {
        expect('lastDate' in chatToStub(blankChat({ lastDate: null as any }))).toBe(true)
        expect('lastDate' in chatToStub(blankChat({ lastDate: 0 }))).toBe(true)
        expect('lastDate' in chatToStub(blankChat())).toBe(false)
    })

    test('returns input untouched when already a stub', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        expect(chatToStub(stub)).toBe(stub)
    })
})

describe('stubToPlaceholder', () => {
    test('preserves explicit null folderId from server', () => {
        const stub: ChatStub = {
            id: 'c1',
            name: 't',
            _stub: true,
            folderId: null as any,
        }
        const placeholder = stubToPlaceholder(stub)
        expect('folderId' in placeholder).toBe(true)
        expect(placeholder.folderId).toBeNull()
    })

    test('omits folderId when stub has no such key', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const placeholder = stubToPlaceholder(stub)
        expect('folderId' in placeholder).toBe(false)
    })

    test('marks placeholder for hydration', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const placeholder = stubToPlaceholder(stub)
        expect(placeholder._placeholder).toBe(true)
        expect(placeholder.fmIndex).toBe(-1)
        expect(placeholder.message).toEqual([])
    })

    test('preserves modules key (null and array)', () => {
        const nullStub: ChatStub = { id: 'c1', name: 't', _stub: true, modules: null as any }
        expect('modules' in stubToPlaceholder(nullStub)).toBe(true)
        expect(stubToPlaceholder(nullStub).modules).toBeNull()

        const arrStub: ChatStub = { id: 'c1', name: 't', _stub: true, modules: ['m1'] }
        expect(stubToPlaceholder(arrStub).modules).toEqual(['m1'])
    })
})

// The bug this branch fixes: a user clearing folderId would round-trip into
// a "remove" patch op once the placeholder dropped the null key. With key
// presence preserved end-to-end, the explicit null survives placeholder →
// stub conversion and reaches the server merge layer as a real value.
describe('chat → stub → placeholder → stub round-trip', () => {
    test('null folderId survives the full round-trip', () => {
        const original = blankChat({ folderId: null as any })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('folderId' in stub2).toBe(true)
        expect(stub2.folderId).toBeNull()
    })

    test('null modules survives the full round-trip', () => {
        const original = blankChat({ modules: null as any })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('modules' in stub2).toBe(true)
        expect(stub2.modules).toBeNull()
    })

    test('absent folderId stays absent through the round-trip', () => {
        const original = blankChat()
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('folderId' in stub2).toBe(false)
    })

    test('non-null folderId survives the round-trip unchanged', () => {
        const original = blankChat({ folderId: 'F1' })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect(stub2.folderId).toBe('F1')
    })
})

// Hybrid corruption: a chat with `_stub: true` AND a real message array.
// Came from v1.4.x disk corruption. The lazy-loading invariants assume
// `_stub: true` means "metadata only", so the hybrid leaks Chat fields into
// patcher diffs and trips the chat-data guard. The fix self-heals by
// excluding hybrids from isChatStub (so chatToStub strips them properly)
// and by stripping the corrupt _stub flag in convertStubsToPlaceholders
// (preserving the real message data instead of resetting to placeholder).
describe('hybrid corruption (chat with _stub:true + message)', () => {
    const hybridChat = (overrides: any = {}): any => ({
        message: [{ role: 'user', data: 'hello' }],
        note: 'old note',
        name: 'h',
        localLore: [{ key: 'k' }],
        id: 'c-hybrid',
        _stub: true,
        ...overrides,
    })

    test('classifyChat tags _stub + message as "hybrid"', () => {
        expect(classifyChat(hybridChat())).toBe('hybrid')
    })

    test('chatToStub collapses hybrid down to a real stub (drops message)', () => {
        const result = chatToStub(hybridChat()) as any
        expect(result._stub).toBe(true)
        expect('message' in result).toBe(false)
        expect('note' in result).toBe(false)
        expect('localLore' in result).toBe(false)
        expect(result.id).toBe('c-hybrid')
        expect(result.name).toBe('h')
    })

    test('convertStubsToPlaceholders keeps hybrid as a Chat with message preserved', () => {
        const [recovered] = convertStubsToPlaceholders([hybridChat()])
        // _stub flag must be gone — leaving it would re-enter the hybrid loop.
        expect((recovered as any)._stub).toBeUndefined()
        // Original message must survive — converting to a placeholder would
        // reset it to [], which IS the data-loss bug we're guarding against.
        expect(Array.isArray(recovered.message)).toBe(true)
        expect(recovered.message.length).toBe(1)
        expect(recovered.message[0].data).toBe('hello')
        expect(recovered.note).toBe('old note')
        expect(recovered.localLore.length).toBe(1)
    })

    test('convertStubsToPlaceholders still converts real stubs to placeholders', () => {
        const realStub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const [result] = convertStubsToPlaceholders([realStub])
        expect((result as any)._placeholder).toBe(true)
        expect(result.message).toEqual([])
        expect(result.fmIndex).toBe(-1)
    })

    test('convertStubsToPlaceholders leaves real Chats alone', () => {
        const realChat: Chat = {
            message: [], note: '', name: 'x', localLore: [], id: 'c2',
        }
        const [result] = convertStubsToPlaceholders([realChat])
        expect(result).toBe(realChat)   // same reference, untouched
    })

    test('hybrid round-trip self-heals: convert → chatToStub → no message leakage', () => {
        // Simulate the actual v1.4.x bug path:
        //   disk → decoded chat is hybrid → convertStubsToPlaceholders → patcher diff
        const [recovered] = convertStubsToPlaceholders([hybridChat()])
        const stub = chatToStub(recovered) as any
        expect(stub._stub).toBe(true)
        expect('message' in stub).toBe(false)
        expect('note' in stub).toBe(false)
        // Once stripped, the chat-data guard would see no chat-internal field
        // ops in a baseline-vs-current diff between two of these stubs.
    })
})

describe('bounded hydrated-chat LRU', () => {
    test('keeps only twelve clean server-hydrated chats while browsing', async () => {
        const arrays: Chat[][] = []
        for (let i = 0; i < 15; i++) {
            const chats = [stubToPlaceholder({ id: `chat-${i}`, name: `${i}`, _stub: true })]
            arrays.push(chats)
            await ensureChatHydrated(chats, 0, `char-${i}`)
        }
        expect(hydratedChatCacheSize()).toBe(12)
        expect(arrays.slice(0, 3).every((chats) => chats[0]._placeholder)).toBe(true)
        expect(arrays.slice(3).every((chats) => !chats[0]._placeholder)).toBe(true)
    })

    test('pins dirty chats until their server save succeeds', async () => {
        const dirtyChats = [stubToPlaceholder({ id: 'dirty-chat', name: 'dirty', _stub: true })]
        await ensureChatHydrated(dirtyChats, 0, 'dirty-char')
        markHydratedChatDirty('dirty-char', 'dirty-chat')

        for (let i = 0; i < 14; i++) {
            const chats = [stubToPlaceholder({ id: `other-${i}`, name: `${i}`, _stub: true })]
            await ensureChatHydrated(chats, 0, `other-char-${i}`)
        }
        expect(dirtyChats[0]._placeholder).not.toBe(true)

        markHydratedChatPersisted('dirty-char', 'dirty-chat')
        await evictHydratedChatCache(undefined, 0)
        expect(dirtyChats[0]._placeholder).toBe(true)
    })
})

describe('hydrating a chat whose body is missing on the server', () => {
    // Regression: a chat listed in the catalog but with no body on the server
    // left its placeholder in place, and the chat screen — which waits on
    // `!slot._placeholder` — sat on "loading chat data" forever. This showed up
    // most on a freshly imported bot's first chat, whose body never reached the
    // server. Only a 404 reaches this path; every other failure throws.
    test('opens it as an empty usable chat instead of spinning forever', async () => {
        mocks.fetchChatContent.mockResolvedValueOnce(null)
        const chats = [stubToPlaceholder({
            id: 'orphan-chat', name: 'orphan', _stub: true, folderId: 'f1',
        } as ChatStub)]

        const result = await ensureChatHydrated(chats, 0, 'char-a')

        expect(result).not.toBeNull()
        expect(chats[0]._placeholder).toBeUndefined()
        expect(chats[0].message).toEqual([])
        // Stub metadata has to survive so the chat keeps its identity.
        expect(chats[0].id).toBe('orphan-chat')
        expect(chats[0].name).toBe('orphan')
        expect(chats[0].folderId).toBe('f1')
    })

    // The recovery must never fire for a transient failure: materializing an
    // empty chat there would overwrite a perfectly good server copy on the next
    // save. fetchChatContent throws for anything that is not a 404.
    test('propagates a transient failure rather than emptying the chat', async () => {
        mocks.fetchChatContent.mockRejectedValueOnce(new Error('fetchChatContent error: 503'))
        const chats = [stubToPlaceholder({ id: 'live-chat', name: 'live', _stub: true } as ChatStub)]

        await expect(ensureChatHydrated(chats, 0, 'char-a')).rejects.toThrow('503')
        expect(chats[0]._placeholder).toBe(true)
        expect(chats[0].message).toEqual([])
    })
})

describe('recovered chat persistence', () => {
    // Regression: recovery left the chat clean, so the LRU evicted it straight
    // back to a placeholder and the next open hydrated, 404'd and recovered
    // again. One chat looped 25 times in a real session instead of healing.
    test('pins the recovered chat and asks the save loop to write it', async () => {
        const requested: [string, string][] = []
        setChatSaveRequester((chaId, chatId) => { requested.push([chaId, chatId]) })
        try {
            mocks.fetchChatContent.mockResolvedValueOnce(null)
            const chats = [stubToPlaceholder({ id: 'orphan', name: 'orphan', _stub: true } as ChatStub)]

            await ensureChatHydrated(chats, 0, 'char-a')

            expect(requested).toEqual([['char-a', 'orphan']])

            // Dirty entries survive eviction, so the placeholder cannot come back.
            await evictHydratedChatCache(undefined, 0)
            expect(chats[0]._placeholder).toBeUndefined()
        } finally {
            setChatSaveRequester(null)
        }
    })
})

describe('bodies another device saved', () => {
    test('replaceChatBody swaps the body in but keeps the catalog fields and reads as clean', async () => {
        const chats: Chat[] = [{ ...blankChat({ id: 'x', name: 'Catalog name', lastDate: 5, folderId: 'f' }), message: [{ role: 'user', data: 'old' }] }]
        const newer: Chat = { ...blankChat({ id: 'x', name: 'Body name', lastDate: 9 }), message: [{ role: 'user', data: 'old' }, { role: 'char', data: 'new' }], isStreaming: true }

        const pending = replaceChatBody(chats, 'c', 'x', newer)
        // The write lands while tracking is paused, so it is not a local edit.
        expect(isHydrating('c', 'x')).toBe(true)
        expect(await pending).toBe(true)
        expect(isHydrating('c', 'x')).toBe(false)

        expect(chats[0]).toBe(newer)
        expect(chats[0].message).toHaveLength(2)
        expect(chats[0]).toMatchObject({ name: 'Catalog name', lastDate: 5, folderId: 'f', isStreaming: false })
        expect(isHydratedChatDirty('c', 'x')).toBe(false)
        expect(hydratedChatCacheSize()).toBe(1)
    })

    test('replaceChatBody leaves placeholders alone; they load the newest body when opened', async () => {
        const chats: Chat[] = [stubToPlaceholder({ id: 'x', name: 'n', _stub: true } as ChatStub)]
        expect(await replaceChatBody(chats, 'c', 'x', blankChat({ id: 'x' }))).toBe(false)
        expect(chats[0]._placeholder).toBe(true)
    })

    test('rehomeHydratedChats follows a body into its new array and forgets removed chats', async () => {
        const oldChats: Chat[] = [blankChat({ id: 'keep' }), blankChat({ id: 'gone' })]
        await replaceChatBody(oldChats, 'c', 'keep', blankChat({ id: 'keep' }))
        await replaceChatBody(oldChats, 'c', 'gone', blankChat({ id: 'gone' }))
        expect(hydratedChatCacheSize()).toBe(2)

        const newChats: Chat[] = [oldChats[0]]
        rehomeHydratedChats([{ chaId: 'c', chats: newChats }])
        expect(hydratedChatCacheSize()).toBe(1)

        // Eviction now edits the array the UI shows, not the discarded one.
        await evictHydratedChatCache(undefined, 0)
        expect(newChats[0]._placeholder).toBe(true)
    })

    test('suppressChatTracking pauses only the given chats and releases them', () => {
        const release = suppressChatTracking([{ chaId: 'c', chatId: 'a' }])
        expect(isHydrating('c', 'a')).toBe(true)
        expect(isHydrating('c', 'b')).toBe(false)
        release()
        expect(isHydrating('c', 'a')).toBe(false)
    })
})
