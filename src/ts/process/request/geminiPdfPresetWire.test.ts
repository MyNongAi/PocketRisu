import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadBundledRegistry, resolveSnapshot } from 'src/ts/preset/registry'
import * as serviceAccountCache from 'src/ts/preset/adapter/googleServiceAccount/cache'
import { sendGoogleChatRequest } from 'src/ts/preset/adapter/googleGemini'
import type { AdapterChatMessage } from 'src/ts/preset/adapter/types'
import type { ModelPreset } from 'src/ts/preset/types'
import { clearGeminiPdfRenderMemo, withGeminiPdfInput, type GeminiPdfRenderer } from './geminiPdfInput'

// GEMINI-PDF-INPUT on the google-gemini model-preset path, end to end: the
// real adapter builds and serializes the body, withGeminiPdfInput (as
// request.ts wires it) swaps the context for a PDF and adds the "PDF
// resolution" setting, and the transport sees the final request. No network:
// the transport is a stub and the PDF renderer is injected.

const SA_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'demo',
    private_key_id: 'kid-1',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIBVwIB...\n-----END PRIVATE KEY-----\n',
    client_email: 'svc@demo.iam.gserviceaccount.com',
    client_id: '1',
    token_uri: 'https://oauth2.googleapis.com/token',
})

const LEVELS = {
    low: 'MEDIA_RESOLUTION_LOW',
    medium: 'MEDIA_RESOLUTION_MEDIUM',
    high: 'MEDIA_RESOLUTION_HIGH',
} as const

const LONG = '긴 설정 문장입니다. A long context line. '.repeat(60)

function aiStudioPreset(modelId: string): ModelPreset {
    return {
        id: 'preset-studio',
        name: 'AI Studio',
        profileSnapshot: {
            profileId: 'demo:google',
            profileVersion: 1,
            providerBaseId: 'google',
            providerBaseVersion: 1,
            adapterKind: 'google-gemini',
            auth: { kind: 'x-goog-api-key', fields: ['apiKey'] },
            endpoint: { kind: 'static', url: 'https://generativelanguage.googleapis.com/v1beta/models' },
            modelId,
            schema: [
                { key: 'apiKey', type: 'string', label: 'API Key', secret: true, mapsTo: { target: 'auth', path: 'apiKey' } },
                { key: 'modelId', type: 'string', label: 'Model ID', default: modelId, mapsTo: { target: 'body', path: 'model' } },
            ],
            uiSchema: { groups: [], fields: [] },
            defaults: {},
            headerTemplate: { 'Content-Type': 'application/json' },
            capabilities: ['streaming'],
        },
        userValues: {},
        customBody: { generationConfig: { maxOutputTokens: 777 } },
        createdAt: 0,
        updatedAt: 0,
    }
}

// A shipped Vertex Gemini native profile with its model overridden.
function vertexPreset(modelId: string): ModelPreset {
    return {
        id: 'preset-vertex',
        name: 'Vertex',
        profileSnapshot: resolveSnapshot(loadBundledRegistry(), 'vertex-gemini-native:gemini-35-flash'),
        userValues: { projectId: 'demo', modelId },
        createdAt: 0,
        updatedAt: 0,
    }
}

function messages(withImage = false): AdapterChatMessage[] {
    return [
        { role: 'system', content: LONG },
        { role: 'user', content: '안녕' },
        { role: 'assistant', content: 'Hello!' },
        withImage
            ? { role: 'user', content: '이 그림', images: [{ kind: 'image', mime: 'image/png', base64: 'iVBORw0K' }] }
            : { role: 'user', content: '마지막 질문' },
    ]
}

const render: GeminiPdfRenderer = async () => ({ ok: true, data: 'UERGREFUQQ==', pages: 2 })

interface Sent {
    url: string
    body: any
    log?: any
}

async function send(preset: ModelPreset, mediaResolution: string | undefined, withImage = false): Promise<Sent> {
    const calls: { url: string, body: string }[] = []
    const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: init?.body as string })
        return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }), { status: 200 })
    }) as typeof fetch
    let log: string | undefined
    const fetchImpl = withGeminiPdfInput(transport, { render, mediaResolution, onApplied: (body) => { log = body } })
    const credential = preset.profileSnapshot.auth.kind === 'google-service-account' ? { apiKey: SA_JSON } : { apiKey: 'studio-key' }
    const result = await sendGoogleChatRequest(preset, { messages: messages(withImage), fetchImpl }, credential)
    expect(result.text).toBe('ok')
    expect(calls).toHaveLength(1)
    return { url: calls[0].url, body: JSON.parse(calls[0].body), log: log ? JSON.parse(log) : undefined }
}

beforeEach(() => {
    vi.spyOn(serviceAccountCache, 'getDefaultServiceAccountTokenCache').mockReturnValue({
        getAccessToken: async () => ({ accessToken: 'ya29.test', tokenType: 'Bearer', expiresAtMs: Date.now() + 3_600_000 }),
        clear() {},
    })
    vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
    clearGeminiPdfRenderMemo()
})

const PRESETS = [
    { name: 'AI Studio gemini-3.5-flash', preset: () => aiStudioPreset('gemini-3.5-flash'), model: 'gemini-3.5-flash', placement: 'part' as const },
    { name: 'Vertex gemini-3.7-flash', preset: () => vertexPreset('gemini-3.7-flash'), model: 'gemini-3.7-flash', placement: 'part' as const },
    { name: 'AI Studio gemini-2.5-flash', preset: () => aiStudioPreset('gemini-2.5-flash'), model: 'gemini-2.5-flash', placement: 'generationConfig' as const },
    { name: 'Vertex gemini-2.5-pro', preset: () => vertexPreset('gemini-2.5-pro'), model: 'gemini-2.5-pro', placement: 'generationConfig' as const },
]

describe('google-gemini preset: PDF media resolution on the wire', () => {
    it.each(PRESETS)('$name: default sends the PDF with no media resolution', async ({ preset, model }) => {
        const sent = await send(preset(), 'default')
        expect(sent.url).toContain(`/models/${model}:generateContent`)
        expect(sent.body.systemInstruction).toBeUndefined()
        expect(sent.body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'application/pdf', data: 'UERGREFUQQ==' } })
        expect(JSON.stringify(sent.body)).not.toMatch(/media_?resolution/i)
        expect(sent.log._sentAsPdf).toEqual({ pages: 2 })
    })

    for (const [option, level] of Object.entries(LEVELS)) {
        it.each(PRESETS)(`$name: ${option} goes on the $placement`, async ({ preset, placement }) => {
            const baseline = await send(preset(), 'default')
            const sent = await send(preset(), option)
            // Only the media resolution differs from the default request.
            const expected = structuredClone(baseline.body)
            if (placement === 'part') {
                expected.contents[0].parts[0].mediaResolution = { level }
            } else {
                expected.generationConfig = { ...expected.generationConfig, mediaResolution: level }
            }
            expect(sent.url).toBe(baseline.url)
            expect(sent.body).toEqual(expected)
            expect(JSON.stringify(sent.body).match(/mediaResolution/g)).toHaveLength(1)
            expect(sent.log._sentAsPdf).toEqual({ pages: 2, mediaResolution: { level, placement } })
        })
    }

    it('keeps the customBody generation settings next to a request-wide level', async () => {
        const sent = await send(aiStudioPreset('gemini-2.5-flash'), 'low')
        expect(sent.body.generationConfig).toEqual({ maxOutputTokens: 777, mediaResolution: 'MEDIA_RESOLUTION_LOW' })
    })

    it('an image sent with the latest message keeps its resolution on every model', async () => {
        const gemini3 = await send(aiStudioPreset('gemini-3.5-flash'), 'low', true)
        expect(gemini3.body.contents[0].parts[0].mediaResolution).toEqual({ level: 'MEDIA_RESOLUTION_LOW' })
        expect(gemini3.body.contents[0].parts.at(-1)).toEqual({ inlineData: { mimeType: 'image/png', data: 'iVBORw0K' } })
        expect(gemini3.body.generationConfig).toEqual({ maxOutputTokens: 777 })

        // Earlier models only have the request-wide field, which the image
        // would follow too: nothing is set.
        const gemini25 = await send(aiStudioPreset('gemini-2.5-flash'), 'low', true)
        expect(gemini25.body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'application/pdf', data: 'UERGREFUQQ==' } })
        expect(gemini25.body.generationConfig).toEqual({ maxOutputTokens: 777 })
        expect(gemini25.log._sentAsPdf).toEqual({ pages: 2 })
    })
})
