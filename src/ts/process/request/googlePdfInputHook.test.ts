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

// The "PDF resolution" setting (nodeOnlyGeminiPdfMediaResolution) on the
// classic path: per part on Gemini 3 models, request-wide (generation_config)
// on earlier ones, nothing for 'default'.
describe('google.ts Gemini PDF media resolution', () => {
    const LEVELS = {
        low: 'MEDIA_RESOLUTION_LOW',
        medium: 'MEDIA_RESOLUTION_MEDIUM',
        high: 'MEDIA_RESOLUTION_HIGH',
    } as const

    function modelInfo(internalID: string, format: 'GoogleCloud' | 'VertexAIGemini' = 'GoogleCloud', flags: string[] = []) {
        return { id: internalID, internalID, format, flags, parameters: [] }
    }

    function vertexDb() {
        mocks.db.google.projectId = 'proj'
        mocks.db.vertexAccessToken = 'vertex-token'
        mocks.db.vertexAccessTokenExpires = Date.now() + 3_600_000
    }

    const cases: { option: keyof typeof LEVELS, model: string, format: 'GoogleCloud' | 'VertexAIGemini', placement: 'part' | 'generationConfig' }[] = []
    for (const option of Object.keys(LEVELS) as (keyof typeof LEVELS)[]) {
        cases.push(
            { option, model: 'gemini-3-flash-preview', format: 'GoogleCloud', placement: 'part' },
            { option, model: 'gemini-3.5-flash', format: 'VertexAIGemini', placement: 'part' },
            { option, model: 'gemini-2.5-flash', format: 'GoogleCloud', placement: 'generationConfig' },
            { option, model: 'gemini-2.5-pro', format: 'VertexAIGemini', placement: 'generationConfig' },
        )
    }

    it.each(cases)('$option on $model ($format) goes on the $placement', async ({ option, model, format, placement }) => {
        mocks.db.nodeOnlyGeminiPdfInput = true
        mocks.db.nodeOnlyGeminiPdfMediaResolution = option
        if (format === 'VertexAIGemini') vertexDb()
        await requestGoogleCloudVertex(arg({ modelInfo: modelInfo(model, format) }))

        const url = mocks.fetchNative.mock.calls[0][0] as string
        expect(url).toContain(`/models/${model}:generateContent`)
        const body = sentBody()
        const pdfPart = body.contents[0].parts[0]
        expect(pdfPart.inlineData).toEqual({ mimeType: 'application/pdf', data: 'UERGREFUQQ==' })
        if (placement === 'part') {
            expect(pdfPart.mediaResolution).toEqual({ level: LEVELS[option] })
            expect(body.generation_config).not.toHaveProperty('mediaResolution')
        } else {
            expect(pdfPart).not.toHaveProperty('mediaResolution')
            expect(body.generation_config).toEqual({ maxOutputTokens: 256, mediaResolution: LEVELS[option] })
        }
        expect(JSON.parse(mocks.fetchNative.mock.calls[0][1].logBody)._sentAsPdf)
            .toEqual({ pages: 1, mediaResolution: { level: LEVELS[option], placement } })
    })

    it('default (and an unset value) adds no media resolution on any model', async () => {
        mocks.db.nodeOnlyGeminiPdfInput = true
        for (const value of ['default', undefined]) {
            for (const model of ['gemini-3-flash-preview', 'gemini-2.5-flash']) {
                mocks.db.nodeOnlyGeminiPdfMediaResolution = value
                mocks.fetchNative.mockClear()
                await requestGoogleCloudVertex(arg({ modelInfo: modelInfo(model) }))
                const raw = mocks.fetchNative.mock.calls[0][1].body as string
                expect(raw).not.toMatch(/media_?resolution/i)
                expect(JSON.parse(raw).contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'application/pdf', data: 'UERGREFUQQ==' } })
                expect(JSON.parse(mocks.fetchNative.mock.calls[0][1].logBody)._sentAsPdf).toEqual({ pages: 1 })
            }
        }
    })

    it('does nothing while the PDF toggle is off', async () => {
        mocks.db.nodeOnlyGeminiPdfInput = false
        mocks.db.nodeOnlyGeminiPdfMediaResolution = 'low'
        await requestGoogleCloudVertex(arg({ modelInfo: modelInfo('gemini-2.5-flash') }))
        expect(JSON.stringify(sentBody())).not.toMatch(/media_?resolution/i)
        expect(renderFetch).not.toHaveBeenCalled()
    })

    // An image sent with the latest message: Gemini 3 changes only the PDF;
    // an earlier model would change the image too, so the request keeps the
    // vision-quality value it had.
    it('leaves images with their vision-quality resolution', async () => {
        mocks.db.nodeOnlyGeminiPdfInput = true
        mocks.db.nodeOnlyGeminiPdfMediaResolution = 'low'
        mocks.db.gptVisionQuality = 'high'
        const withImage = (model: string) => arg({
            modelInfo: modelInfo(model, 'GoogleCloud', ['hasImageInput']),
            formated: [
                { role: 'system', content: SYSTEM },
                { role: 'user', content: '안녕' },
                { role: 'assistant', content: 'Hello!' },
                { role: 'user', content: '이 그림', multimodals: [{ type: 'image', base64: 'data:image/png;base64,iVBORw0K' }] },
            ],
        })

        await requestGoogleCloudVertex(withImage('gemini-3-flash-preview'))
        const gemini3 = sentBody()
        expect(gemini3.contents[0].parts[0].mediaResolution).toEqual({ level: 'MEDIA_RESOLUTION_LOW' })
        expect(gemini3.contents[0].parts[3]).toEqual({ inlineData: { mimeType: 'image/png', data: 'iVBORw0K' } })
        expect(gemini3.generation_config.mediaResolution).toBe('MEDIA_RESOLUTION_MEDIUM')

        mocks.fetchNative.mockClear()
        await requestGoogleCloudVertex(withImage('gemini-2.5-flash'))
        const gemini25 = sentBody()
        expect(gemini25.contents[0].parts[0]).not.toHaveProperty('mediaResolution')
        expect(gemini25.generation_config.mediaResolution).toBe('MEDIA_RESOLUTION_MEDIUM')
    })
})
