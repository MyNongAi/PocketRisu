import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// GEMINI-PDF-INPUT hook in the classic Google path (google.ts): with the
// toggle on, the body handed to fetchNative carries the context as a PDF; off
// (or unset) and for previews, the request is the plain one as before.

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
const { clearGeminiPdfRenderMemo } = await import('./geminiPdfInput')

const SYSTEM = '당신은 이야기꾼입니다. You are a storyteller. '.repeat(50)

function arg(overrides: Record<string, unknown> = {}): any {
    return {
        formated: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: '안녕' },
            { role: 'assistant', content: 'Hello!' },
            { role: 'user', content: '마지막 질문' },
        ],
        modelInfo: { id: 'gemini-3-flash-preview', internalID: 'gemini-3-flash-preview', format: 'GoogleCloud', flags: [], parameters: [] },
        maxTokens: 256,
        mode: 'model',
        useStreaming: false,
        key: 'test-key',
        chatId: 'chat-1',
        ...overrides,
    }
}

let renderFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
    mocks.db = { google: { accessToken: 'test-key', projectId: '' }, vertexRegion: 'global' }
    mocks.fetchNative = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 }))
    renderFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: 'UERGREFUQQ==', pages: 1, bytes: 7 }), { status: 200 }))
    vi.stubGlobal('fetch', renderFetch)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    clearGeminiPdfRenderMemo()
})

function sentBody(): any {
    expect(mocks.fetchNative).toHaveBeenCalledTimes(1)
    return JSON.parse(mocks.fetchNative.mock.calls[0][1].body)
}

describe('google.ts Gemini PDF input hook', () => {
    it('sends the context as a PDF when the toggle is on', async () => {
        mocks.db.nodeOnlyGeminiPdfInput = true
        const result = await requestGoogleCloudVertex(arg())
        expect(result).toMatchObject({ type: 'success', result: 'ok' })

        expect(renderFetch).toHaveBeenCalledTimes(1)
        expect(renderFetch.mock.calls[0][0]).toBe('/api/gemini/pdf-input')
        const { blocks } = JSON.parse((renderFetch.mock.calls[0][1] as RequestInit).body as string)
        expect(blocks).toEqual([
            { role: 'system', text: SYSTEM },
            { role: 'user', text: '안녕' },
            { role: 'assistant', text: 'Hello!' },
        ])

        const body = sentBody()
        expect(body.systemInstruction).toBeUndefined()
        expect(body.contents).toHaveLength(1)
        expect(body.contents[0].role).toBe('user')
        expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'application/pdf', data: 'UERGREFUQQ==' } })
        expect(body.contents[0].parts[2]).toEqual({ text: '마지막 질문' })
        expect(body.generation_config.maxOutputTokens).toBe(256)

        // The request log keeps the text form, marked, for request-log chat recovery.
        const logged = JSON.parse(mocks.fetchNative.mock.calls[0][1].logBody)
        expect(logged._sentAsPdf).toEqual({ pages: 1 })
        expect(logged.systemInstruction.parts[0].text).toBe(SYSTEM)
        expect(logged.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user'])
    })

    it('leaves the request as plain text when the toggle is off or unset', async () => {
        for (const value of [undefined, false]) {
            mocks.db.nodeOnlyGeminiPdfInput = value
            mocks.fetchNative.mockClear()
            await requestGoogleCloudVertex(arg())
            const body = sentBody()
            expect(body.systemInstruction.parts[0].text).toBe(SYSTEM)
            expect(body.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user'])
            expect(mocks.fetchNative.mock.calls[0][1].logBody).toBeUndefined()
        }
        expect(renderFetch).not.toHaveBeenCalled()
    })

    it('falls back to the plain request when the server cannot render', async () => {
        mocks.db.nodeOnlyGeminiPdfInput = true
        renderFetch.mockImplementation(async () => new Response(JSON.stringify({ ok: false, reason: 'too-large' }), { status: 413 }))
        const result = await requestGoogleCloudVertex(arg())
        expect(result).toMatchObject({ type: 'success', result: 'ok' })
        expect(sentBody().systemInstruction.parts[0].text).toBe(SYSTEM)
    })

    it('keeps previews on the plain body', async () => {
        mocks.db.nodeOnlyGeminiPdfInput = true
        const result = await requestGoogleCloudVertex(arg({ previewBody: true }))
        const preview = JSON.parse(result.result as string)
        expect(preview.body.systemInstruction.parts[0].text).toBe(SYSTEM)
        expect(renderFetch).not.toHaveBeenCalled()
        expect(mocks.fetchNative).not.toHaveBeenCalled()
    })
})
