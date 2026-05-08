import { describe, test, expect, vi } from 'vitest'

// Stub out the heavy reactive modules so loading chatStorage.ts doesn't trigger
// unrelated $effect chains that fail in a stripped-down test environment.
// chatToStub / stubToPlaceholder themselves only depend on isChatStub.
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))
vi.mock('./database.svelte', () => ({
    isChatStub: (chat: any) => chat && chat._stub === true,
}))

const { chatToStub, stubToPlaceholder } = await import('./chatStorage')
type Chat = any
type ChatStub = any

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
