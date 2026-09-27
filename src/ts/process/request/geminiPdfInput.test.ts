import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// renderGeminiPdfOnServer reaches globalApi only for the auth header.
vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: { createAuth: async () => 'test-auth' },
}))

import {
    GEMINI_PDF_FRAMING_TEXT,
    GEMINI_PDF_MAX_PREFIX_CHARS,
    applyGeminiPdfInput,
    buildGeminiPdfBody,
    clearGeminiPdfRenderMemo,
    planGeminiPdfInput,
    renderGeminiPdfOnServer,
    withGeminiPdfInput,
    type GeminiPdfBlock,
    type GeminiPdfRenderer,
} from './geminiPdfInput'

const LONG = '긴 설정 문장입니다. A long context line. '.repeat(60) // ~2,000 chars

// The request body shape google.ts builds (camelCase parts, snake-case
// generation_config), with a system instruction, history and a model prefill.
function classicBody(overrides: Record<string, unknown> = {}) {
    return {
        contents: [
            { role: 'user', parts: [{ text: '첫 질문' }] },
            { role: 'model', parts: [{ text: '첫 답변 ' }, { text: 'continued' }] },
            { role: 'user', parts: [{ text: '두 번째 질문' }] },
            { role: 'model', parts: [{ thought: true, text: 'hidden reasoning' }, { text: '두 번째 답변', thoughtSignature: 'sig-1' }, { thoughtSignature: 'sig-2' }] },
            { role: 'user', parts: [{ text: '마지막 질문' }, { inlineData: { mimeType: 'image/png', data: 'iVBORw0K' } }] },
            { role: 'model', parts: [{ text: 'Prefill:' }] },
        ],
        generation_config: { maxOutputTokens: 1024, temperature: 0.8 },
        safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' }],
        systemInstruction: { parts: [{ text: LONG }] },
        ...overrides,
    }
}

const okRenderer = (data = 'UERGREFUQQ==', pages = 3): GeminiPdfRenderer => vi.fn(async () => ({ ok: true as const, data, pages }))

beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    clearGeminiPdfRenderMemo()
})

describe('planGeminiPdfInput', () => {
    it('maps the system instruction and earlier turns to role blocks', () => {
        const plan = planGeminiPdfInput(classicBody())
        expect(plan.apply).toBe(true)
        if (!plan.apply) return
        expect(plan.lastUserIndex).toBe(4)
        expect(plan.blocks).toEqual<GeminiPdfBlock[]>([
            { role: 'system', text: LONG },
            { role: 'user', text: '첫 질문' },
            // model text parts are fragments of one answer: joined without a separator
            { role: 'assistant', text: '첫 답변 continued' },
            { role: 'user', text: '두 번째 질문' },
            // thought parts and signature-only parts are dropped
            { role: 'assistant', text: '두 번째 답변' },
        ])
        expect(plan.chars).toBe(plan.blocks.reduce((n, b) => n + b.text.length, 0))
    })

    it('finds the LAST user turn even when a model prefill follows it', () => {
        const body = classicBody()
        const plan = planGeminiPdfInput(body)
        expect(plan.apply && plan.lastUserIndex).toBe(4)
        // No user turn at all → nothing to anchor on.
        expect(planGeminiPdfInput({ contents: [{ role: 'model', parts: [{ text: LONG }] }] })).toMatchObject({ apply: false })
    })

    it('reads snake_case system_instruction too', () => {
        const body = classicBody({ systemInstruction: undefined, system_instruction: { parts: [{ text: LONG }] } })
        const plan = planGeminiPdfInput(body)
        expect(plan.apply && plan.blocks[0]).toEqual({ role: 'system', text: LONG })
    })

    it('skips when nothing precedes the last user turn', () => {
        const plan = planGeminiPdfInput({ contents: [{ role: 'user', parts: [{ text: LONG }] }] })
        expect(plan).toEqual({ apply: false, reason: 'nothing before the last user turn' })
        const blankSystem = planGeminiPdfInput({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], systemInstruction: { parts: [{ text: '  ' }] } })
        expect(blankSystem.apply).toBe(false)
    })

    it('applies with only a system instruction before the single user turn', () => {
        const plan = planGeminiPdfInput({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], systemInstruction: { parts: [{ text: LONG }] } })
        expect(plan.apply && plan.blocks).toEqual([{ role: 'system', text: LONG }])
    })

    it('skips on function calls, function responses and declared function tools', () => {
        const withCall = classicBody()
        withCall.contents.splice(1, 0, { role: 'model', parts: [{ functionCall: { name: 'search', args: {} } }] } as any)
        expect(planGeminiPdfInput(withCall)).toMatchObject({ apply: false, reason: 'function call/response parts present' })

        const withResponse = classicBody()
        withResponse.contents.splice(1, 0, { role: 'function', parts: [{ functionResponse: { name: 'search', response: {} } }] } as any)
        expect(planGeminiPdfInput(withResponse)).toMatchObject({ apply: false })

        // google.ts shape (object) and adapter shape (array)
        expect(planGeminiPdfInput(classicBody({ tools: { functionDeclarations: [{ name: 'f' }] } }))).toMatchObject({ apply: false, reason: 'function tools declared' })
        expect(planGeminiPdfInput(classicBody({ tools: [{ functionDeclarations: [{ name: 'f' }] }] }))).toMatchObject({ apply: false, reason: 'function tools declared' })
        // An empty declaration list is not a tool round.
        expect(planGeminiPdfInput(classicBody({ tools: { functionDeclarations: [] } })).apply).toBe(true)
    })

    it('skips when an earlier turn carries media it cannot place', () => {
        const body = classicBody()
        body.contents[0] = { role: 'user', parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/jpeg', data: '/9j/' } }] } as any
        expect(planGeminiPdfInput(body)).toMatchObject({ apply: false, reason: 'non-text part before the last user turn' })
        const withFile = classicBody()
        withFile.contents[0] = { role: 'user', parts: [{ fileData: { mimeType: 'application/pdf', fileUri: 'gs://x' } }] } as any
        expect(planGeminiPdfInput(withFile).apply).toBe(false)
    })

    it('skips with explicit context caching', () => {
        expect(planGeminiPdfInput(classicBody({ cachedContent: 'cachedContents/abc' }))).toMatchObject({ apply: false, reason: 'explicit context cache in use' })
    })

    it('skips contexts too short to save tokens and too large for one PDF', () => {
        expect(planGeminiPdfInput(classicBody({ systemInstruction: { parts: [{ text: 'short' }] } }))).toMatchObject({ apply: false, reason: 'context too short to save tokens' })
        const huge = classicBody({ systemInstruction: { parts: [{ text: 'x'.repeat(GEMINI_PDF_MAX_PREFIX_CHARS + 1) }] } })
        expect(planGeminiPdfInput(huge)).toMatchObject({ apply: false, reason: 'context too large for one PDF' })
    })

    it('skips an unknown role before the last user turn', () => {
        const body = classicBody()
        body.contents.splice(0, 0, { role: 'tool', parts: [{ text: 'x' }] } as any)
        expect(planGeminiPdfInput(body)).toMatchObject({ apply: false })
    })
})

describe('buildGeminiPdfBody', () => {
    it('drops systemInstruction and puts PDF, framing line and last-user parts first; the prefill stays', () => {
        const body = classicBody()
        const plan = planGeminiPdfInput(body)
        if (!plan.apply) throw new Error('expected a plan')
        const next = buildGeminiPdfBody(body, plan, 'QkFTRTY0')
        expect(next).not.toHaveProperty('systemInstruction')
        expect(next.generation_config).toEqual(body.generation_config)
        expect(next.safetySettings).toEqual(body.safetySettings)
        expect(next.contents).toEqual([
            {
                role: 'user',
                parts: [
                    { inlineData: { mimeType: 'application/pdf', data: 'QkFTRTY0' } },
                    { text: GEMINI_PDF_FRAMING_TEXT },
                    { text: '마지막 질문' },
                    { inlineData: { mimeType: 'image/png', data: 'iVBORw0K' } },
                ],
            },
            { role: 'model', parts: [{ text: 'Prefill:' }] },
        ])
        // The input body is not mutated.
        expect(body.contents).toHaveLength(6)
        expect(body.systemInstruction).toBeDefined()
    })

    it('follows snake_case part casing when the body already uses it', () => {
        const body = classicBody()
        body.contents[4] = { role: 'user', parts: [{ text: 'q' }, { inline_data: { mime_type: 'image/png', data: 'x' } }] } as any
        const plan = planGeminiPdfInput(body)
        if (!plan.apply) throw new Error('expected a plan')
        const next = buildGeminiPdfBody(body, plan, 'PDF')
        expect((next.contents as any)[0].parts[0]).toEqual({ inline_data: { mime_type: 'application/pdf', data: 'PDF' } })
    })
})

describe('applyGeminiPdfInput', () => {
    it('renders the planned blocks and returns the rewritten body', async () => {
        const render = okRenderer()
        const body = classicBody()
        const result = await applyGeminiPdfInput(body, { render })
        expect(result.applied).toBe(true)
        expect(result.pages).toBe(3)
        expect(render).toHaveBeenCalledTimes(1)
        const [blocks] = (render as any).mock.calls[0]
        expect(blocks[0]).toEqual({ role: 'system', text: LONG })
        expect((result.body as any).contents[0].parts[0].inlineData.mimeType).toBe('application/pdf')
    })

    it('leaves the body untouched when the server cannot render (size limit, no font, network)', async () => {
        const body = classicBody()
        for (const render of [
            vi.fn(async () => ({ ok: false as const, reason: 'too-large' })),
            vi.fn(async () => ({ ok: false as const, reason: 'no-font' })),
            vi.fn(async () => { throw new TypeError('Failed to fetch') }),
        ]) {
            const result = await applyGeminiPdfInput(body, { render })
            expect(result.applied).toBe(false)
            expect(result.body).toBe(body)
        }
        expect(console.warn).toHaveBeenCalledTimes(1)
    })

    it('does not call the renderer for a skipped request', async () => {
        const render = okRenderer()
        const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }
        const result = await applyGeminiPdfInput(body, { render })
        expect(result).toMatchObject({ applied: false, reason: 'nothing before the last user turn' })
        expect(render).not.toHaveBeenCalled()
        expect(console.debug).toHaveBeenCalledWith(expect.stringContaining('nothing before the last user turn'))
    })

    it('propagates an abort that lands during the render', async () => {
        const controller = new AbortController()
        const render: GeminiPdfRenderer = async () => {
            controller.abort()
            throw new DOMException('aborted', 'AbortError')
        }
        await expect(applyGeminiPdfInput(classicBody(), { render, signal: controller.signal })).rejects.toThrow('aborted')
    })
})

describe('withGeminiPdfInput (model-preset transport)', () => {
    const okResponse = () => new Response('{}', { status: 200 })

    it('rewrites native generateContent / streamGenerateContent bodies', async () => {
        const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse())
        const wrapped = withGeminiPdfInput(inner as unknown as typeof fetch, { render: okRenderer('UERG') })
        const url = 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini-3.7-flash:streamGenerateContent?alt=sse'
        await wrapped(url, { method: 'POST', body: JSON.stringify(classicBody()), headers: { a: 'b' } })
        const [calledUrl, init] = inner.mock.calls[0]
        expect(calledUrl).toBe(url)
        expect((init!.headers as any).a).toBe('b')
        const sent = JSON.parse(init!.body as string)
        expect(sent.systemInstruction).toBeUndefined()
        expect(sent.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'application/pdf', data: 'UERG' } })

        await wrapped('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent', { method: 'POST', body: JSON.stringify(classicBody()) })
        expect(JSON.parse(inner.mock.calls[1][1]!.body as string).contents[0].parts[0].inlineData.data).toBe('UERG')
    })

    it('passes other calls and non-applicable bodies through byte-for-byte', async () => {
        const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse())
        const render = okRenderer()
        const wrapped = withGeminiPdfInput(inner as unknown as typeof fetch, { render })
        const body = JSON.stringify(classicBody())
        await wrapped('https://generativelanguage.googleapis.com/v1beta/cachedContents', { method: 'POST', body })
        expect(inner.mock.calls[0][1]!.body).toBe(body)
        const toolBody = JSON.stringify(classicBody({ tools: [{ functionDeclarations: [{ name: 'f' }] }] }))
        await wrapped('https://x.test/models/m:generateContent', { method: 'POST', body: toolBody })
        expect(inner.mock.calls[1][1]!.body).toBe(toolBody)
        await wrapped('https://x.test/models/m:generateContent', { method: 'POST', body: 'not json' })
        expect(inner.mock.calls[2][1]!.body).toBe('not json')
        expect(render).not.toHaveBeenCalled()
    })

    // Request-log chat recovery rebuilds turns from logged prompts, so the log
    // must see the text form, marked, while the wire gets the PDF.
    it('reports the marked text form for the request log only when applied', async () => {
        const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse())
        const onApplied = vi.fn()
        const wrapped = withGeminiPdfInput(inner as unknown as typeof fetch, { render: okRenderer('UERG'), onApplied })
        const body = classicBody()
        await wrapped('https://x.test/models/m:generateContent', { method: 'POST', body: JSON.stringify(body) })
        expect(onApplied).toHaveBeenCalledTimes(1)
        const logged = JSON.parse(onApplied.mock.calls[0][0])
        expect(logged._sentAsPdf).toBeDefined()
        const { _sentAsPdf, ...rest } = logged
        expect(rest).toEqual(JSON.parse(JSON.stringify(body)))

        await wrapped('https://x.test/cachedContents', { method: 'POST', body: JSON.stringify(body) })
        expect(onApplied).toHaveBeenCalledTimes(1)
    })
})

describe('renderGeminiPdfOnServer', () => {
    const blocks: GeminiPdfBlock[] = [{ role: 'system', text: LONG }]

    it('posts the blocks with risu-auth and memoizes the result for rerolls', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: 'UERG', pages: 2, bytes: 3, cached: false }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const first = await renderGeminiPdfOnServer(blocks)
        expect(first).toEqual({ ok: true, data: 'UERG', pages: 2, bytes: 3, cached: false })
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe('/api/gemini/pdf-input')
        expect((init.headers as Record<string, string>)['risu-auth']).toBe('test-auth')
        expect(JSON.parse(init.body as string)).toEqual({ blocks })
        const second = await renderGeminiPdfOnServer(blocks)
        expect(second).toEqual(first)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('reports the server reason on failure and does not memoize it', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, reason: 'no-font' }), { status: 503 }))
        vi.stubGlobal('fetch', fetchMock)
        expect(await renderGeminiPdfOnServer(blocks)).toEqual({ ok: false, reason: 'no-font' })
        expect(await renderGeminiPdfOnServer(blocks)).toEqual({ ok: false, reason: 'no-font' })
        expect(fetchMock).toHaveBeenCalledTimes(2)
        vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 502 })))
        expect(await renderGeminiPdfOnServer(blocks)).toEqual({ ok: false, reason: 'server answered 502' })
    })

    it('gives up after the render timeout and the request stays plain text', async () => {
        vi.useFakeTimers()
        try {
            vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
                init.signal!.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')))
            })))
            const body = classicBody()
            const pending = applyGeminiPdfInput(body)
            await vi.advanceTimersByTimeAsync(60_000)
            const result = await pending
            expect(result.applied).toBe(false)
            expect(result.body).toBe(body)
        } finally {
            vi.useRealTimers()
        }
    })
})
