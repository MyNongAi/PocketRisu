import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// HYPA-PREFILL-RETRY in the classic Google path (google.ts): Gemini 3 and
// later refuse a request that ends on the model turn, so the body never does;
// a user turn after it asks the model to go on from its pre-written start.

const mocks = vi.hoisted(() => ({
    db: {} as Record<string, any>,
    fetchNative: null as any,
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    fetchNative: (...args: any[]) => mocks.fetchNative(...args),
    textifyReadableStream: async () => '',
    forageStorage: { createAuth: async () => 'test-auth' },
}))
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
    setDatabase: () => {},
}))
vi.mock('src/ts/model/modellist', () => ({
    LLMFlags: new Proxy({}, { get: (_t, key) => String(key) }),
    LLMFormat: { GoogleCloud: 'GoogleCloud', VertexAIGemini: 'VertexAIGemini' },
}))
vi.mock('src/ts/util', () => ({ base64url: () => '', simplifySchema: (schema: unknown) => schema }))
vi.mock('../files/inlays', () => ({ saveInlayedSignature: async () => {}, setInlayAsset: async () => {}, writeInlayImage: async () => {} }))
vi.mock('../templates/jsonSchema', () => ({ extractJSON: (text: string) => text, getGeneralJSONSchema: () => ({}) }))
vi.mock('../mcp/mcp', () => ({ callTool: async () => [], decodeToolCall: async () => null, encodeToolCall: async () => '' }))
vi.mock('src/ts/alert', () => ({ notifyError: () => {} }))
vi.mock('src/ts/stores.svelte', () => ({ bodyIntercepterStore: [] }))
vi.mock('./shared', () => ({
    applyParameters: (base: Record<string, unknown>) => ({ ...base }),
    applyAdditionalParameters: (body: unknown) => body,
    getAdditionalParameters: () => [],
}))

const { requestGoogleCloudVertex } = await import('./google')

const { CONTINUE_FROM_PREFILL } = await import('../memory/trailingPrefill')

function arg(formated: { role: string, content: string }[]): any {
    return {
        formated,
        modelInfo: { id: 'gemini-3-flash-preview', internalID: 'gemini-3-flash-preview', format: 'GoogleCloud', flags: [], parameters: [] },
        maxTokens: 256,
        mode: 'model',
        useStreaming: false,
        key: 'test-key',
        chatId: 'chat-1',
    }
}

beforeEach(() => {
    mocks.db = { google: { accessToken: 'test-key', projectId: '' }, vertexRegion: 'global' }
    mocks.fetchNative = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
})

function sentContents(): any[] {
    expect(mocks.fetchNative).toHaveBeenCalledTimes(1)
    return JSON.parse(mocks.fetchNative.mock.calls[0][1].body).contents
}

describe('a Gemini request never ends on the model turn', () => {
    it('adds a user turn after a pre-written model start (the Default summary prompt)', async () => {
        await requestGoogleCloudVertex(arg([
            { role: 'system', content: 'rules and {{slot}} log' },
            { role: 'user', content: 'how to answer' },
            { role: 'assistant', content: 'Understood. # Response Template' },
        ]))
        const contents = sentContents()
        expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user'])
        expect(contents[1].parts[0].text).toBe('Understood. # Response Template')
        expect(contents[2].parts).toEqual([{ text: CONTINUE_FROM_PREFILL }])
    })

    it('does the same when the model turn is the only one after the system prompt', async () => {
        await requestGoogleCloudVertex(arg([
            { role: 'system', content: 'rules and log' },
            { role: 'assistant', content: 'Summary:' },
        ]))
        expect(sentContents().map((c) => c.role)).toEqual(['model', 'user'])
    })

    it('leaves a request that already ends on the user alone', async () => {
        await requestGoogleCloudVertex(arg([
            { role: 'system', content: 'rules' },
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
            { role: 'user', content: 'go on' },
        ]))
        const contents = sentContents()
        expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user'])
        expect(contents[2].parts[0].text).toBe('go on')
    })
})
