// Gemini PDF input (GEMINI-PDF-INPUT), client half.
//
// With the `nodeOnlyGeminiPdfInput` toggle on, every native-Gemini request
// (AI Studio / Vertex generateContent and streamGenerateContent, classic
// google.ts path and google-gemini model presets alike) sends its long context
// as ONE PDF instead of plain text parts. Gemini bills a PDF page as 258 image
// tokens and Gemini 3 models read the PDF's text layer for free
// (https://ai.google.dev/gemini-api/docs/document-processing), so a dense
// transcript costs far fewer prompt tokens.
//
// The transform (planGeminiPdfInput + buildGeminiPdfBody):
//   - the system instruction and every content BEFORE the last `user` turn
//     become role-labelled blocks ([System] / [User] / [Assistant]) that the
//     server renders into one PDF (server/node/gemini-pdf-input.cjs);
//   - the request becomes: no systemInstruction; first content = a user turn
//     whose parts are [PDF inlineData, one framing line, ...the original
//     last-user parts]; any content after the last user turn (a model prefill)
//     stays as it was.
// Anything that cannot be carried faithfully leaves the request untouched
// (plain text, as before) with a console.debug note; see planGeminiPdfInput.
//
// This module holds no database access: callers gate on the setting and pass
// the renderer, which keeps it unit-testable and out of the adapter layer.

export const GEMINI_PDF_FRAMING_TEXT =
    'The attached PDF contains the system instructions and the conversation so far. '
    + 'Continue the conversation as the assistant, replying to the latest user message below.'

// A one-page PDF still costs 258 tokens, which is about 1,000 characters of
// English text; below that the plain request is already the cheaper one.
export const GEMINI_PDF_MIN_PREFIX_CHARS = 1000
// The server refuses more than ~900 pages (~5M characters); don't upload a
// transcript that cannot fit.
export const GEMINI_PDF_MAX_PREFIX_CHARS = 5_000_000

export type GeminiPdfRole = 'system' | 'user' | 'assistant'

export interface GeminiPdfBlock {
    role: GeminiPdfRole
    text: string
}

export type GeminiPdfPlan =
    | { apply: false; reason: string }
    | { apply: true; blocks: GeminiPdfBlock[]; lastUserIndex: number; chars: number }

export type GeminiPdfRenderResult =
    | { ok: true; data: string; pages?: number; bytes?: number; cached?: boolean }
    | { ok: false; reason: string }

export type GeminiPdfRenderer = (blocks: GeminiPdfBlock[], signal?: AbortSignal) => Promise<GeminiPdfRenderResult>

export interface GeminiPdfApplyResult<T> {
    body: T
    applied: boolean
    reason?: string
    pages?: number
}

type JsonObject = Record<string, unknown>

function isPlainObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function skip(reason: string): GeminiPdfPlan {
    return { apply: false, reason }
}

// Part keys that carry no content of their own. A thoughtSignature only means
// something inside a structured turn history; once history is a document it is
// dropped along with the model's past reasoning (thought: true parts).
const IGNORABLE_PART_KEYS = new Set(['thought', 'thoughtSignature', 'thought_signature'])

// Collects the text of one content's parts. Returns null when a part cannot be
// placed in a text document (inline/file media, executable code, unknown).
function textOfParts(parts: unknown, joiner: string): string | null {
    if (!Array.isArray(parts)) return null
    const texts: string[] = []
    for (const part of parts) {
        if (!isPlainObject(part)) return null
        if (part.thought === true) continue
        const keys = Object.keys(part).filter((key) => !IGNORABLE_PART_KEYS.has(key))
        if (keys.length === 0) continue
        if (keys.length === 1 && keys[0] === 'text' && typeof part.text === 'string') {
            texts.push(part.text)
            continue
        }
        return null
    }
    return texts.join(joiner)
}

function hasFunctionDeclarations(tools: unknown): boolean {
    const list = Array.isArray(tools) ? tools : tools ? [tools] : []
    return list.some((tool) => isPlainObject(tool) && ['functionDeclarations', 'function_declarations'].some((key) => {
        const declarations = tool[key]
        return Array.isArray(declarations) && declarations.length > 0
    }))
}

function hasFunctionParts(contents: unknown[]): boolean {
    return contents.some((content) => isPlainObject(content) && Array.isArray(content.parts) && content.parts.some((part) =>
        isPlainObject(part) && ('functionCall' in part || 'functionResponse' in part || 'function_call' in part || 'function_response' in part)))
}

function systemInstructionOf(body: JsonObject): unknown {
    return body.systemInstruction ?? body.system_instruction
}

// Decides whether (and what) to render. Skips — leaving the request exactly as
// it was — when:
//   - the body is not a native Gemini body, or uses explicit context caching
//     (cachedContent already holds the prefix);
//   - function tools are declared, or any content carries functionCall /
//     functionResponse parts (tool rounds need the real turn structure);
//   - there is no user turn, or nothing (no system instruction, no earlier
//     turn with text) precedes the last one;
//   - an earlier turn or the system instruction holds a non-text part
//     (inlineData / fileData images, audio, video, documents, executable code):
//     moving it out of its turn would detach it from its context;
//   - an earlier turn has a role other than user/model;
//   - the prefix is too short to save tokens or too large for one PDF.
export function planGeminiPdfInput(body: unknown): GeminiPdfPlan {
    if (!isPlainObject(body)) return skip('not a Gemini request body')
    const contents = body.contents
    if (!Array.isArray(contents) || contents.length === 0) return skip('no contents')
    if (body.cachedContent !== undefined || body.cached_content !== undefined) return skip('explicit context cache in use')
    if (hasFunctionDeclarations(body.tools)) return skip('function tools declared')
    if (hasFunctionParts(contents)) return skip('function call/response parts present')

    let lastUserIndex = -1
    for (let i = contents.length - 1; i >= 0; i--) {
        const content = contents[i]
        if (isPlainObject(content) && content.role === 'user') {
            lastUserIndex = i
            break
        }
    }
    if (lastUserIndex < 0) return skip('no user turn')

    const blocks: GeminiPdfBlock[] = []
    const system = systemInstructionOf(body)
    if (system !== undefined && system !== null) {
        if (!isPlainObject(system)) return skip('malformed system instruction')
        const systemText = textOfParts(system.parts, '\n')
        if (systemText === null) return skip('system instruction has non-text parts')
        if (systemText.trim().length > 0) blocks.push({ role: 'system', text: systemText })
    }

    for (let i = 0; i < lastUserIndex; i++) {
        const content = contents[i]
        if (!isPlainObject(content)) return skip('malformed content')
        const role: GeminiPdfRole | null = content.role === 'user' ? 'user' : content.role === 'model' ? 'assistant' : null
        if (!role) return skip(`unsupported role before the last user turn: ${String(content.role)}`)
        // A model turn's text parts are fragments of one answer (the adapter
        // parser joins them with ''); separate user parts get a line break.
        const text = textOfParts(content.parts, role === 'assistant' ? '' : '\n')
        if (text === null) return skip('non-text part before the last user turn')
        if (text.trim().length === 0) continue
        blocks.push({ role, text })
    }

    if (blocks.length === 0) return skip('nothing before the last user turn')
    const chars = blocks.reduce((sum, block) => sum + block.text.length, 0)
    if (chars < GEMINI_PDF_MIN_PREFIX_CHARS) return skip('context too short to save tokens')
    if (chars > GEMINI_PDF_MAX_PREFIX_CHARS) return skip('context too large for one PDF')
    return { apply: true, blocks, lastUserIndex, chars }
}

// The request code writes camelCase (inlineData / mimeType); follow snake_case
// only if the body already uses it.
function usesSnakeCaseParts(contents: unknown[]): boolean {
    return contents.some((content) => isPlainObject(content) && Array.isArray(content.parts)
        && content.parts.some((part) => isPlainObject(part) && ('inline_data' in part || 'file_data' in part)))
}

export function buildGeminiPdfBody<T extends JsonObject>(body: T, plan: Extract<GeminiPdfPlan, { apply: true }>, pdfBase64: string): T {
    const contents = body.contents as JsonObject[]
    const lastUser = contents[plan.lastUserIndex]
    const lastParts = Array.isArray(lastUser.parts) ? lastUser.parts : []
    const pdfPart = usesSnakeCaseParts(contents)
        ? { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } }
        : { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } }
    const next: JsonObject = { ...body }
    delete next.systemInstruction
    delete next.system_instruction
    next.contents = [
        { ...lastUser, role: 'user', parts: [pdfPart, { text: GEMINI_PDF_FRAMING_TEXT }, ...lastParts] },
        ...contents.slice(plan.lastUserIndex + 1),
    ]
    return next as T
}

let warnedUnavailable = false

function noteSkipped(reason: string): void {
    if (reason === 'no-font' && !warnedUnavailable) {
        warnedUnavailable = true
        console.warn('[GeminiPdfInput] The server has no usable font, so Gemini PDF input is unavailable; requests stay plain text.')
        return
    }
    console.debug(`[GeminiPdfInput] left as plain text: ${reason}`)
}

// Retries and rerolls resend the same context; remembering the last couple of
// renders spares the phone the upload + download round trip.
const RENDER_MEMO_SIZE = 2
const renderMemo = new Map<string, Extract<GeminiPdfRenderResult, { ok: true }>>()
// A stuck render must not hold the chat request; on timeout the request goes
// out as plain text.
const RENDER_TIMEOUT_MS = 60_000

export const renderGeminiPdfOnServer: GeminiPdfRenderer = async (blocks, signal) => {
    const payload = JSON.stringify({ blocks })
    const memo = renderMemo.get(payload)
    if (memo) return memo
    const { forageStorage } = await import('src/ts/globalApi.svelte')
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) forwardAbort()
    signal?.addEventListener('abort', forwardAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('PDF render timed out')), RENDER_TIMEOUT_MS)
    let res: Response
    let json: JsonObject | null = null
    try {
        res = await fetch('/api/gemini/pdf-input', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'risu-auth': await forageStorage.createAuth() },
            body: payload,
            signal: controller.signal,
        })
        try {
            json = await res.json() as JsonObject
        } catch {
            json = null
        }
    } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', forwardAbort)
    }
    if (!res.ok || !json || json.ok !== true || typeof json.data !== 'string') {
        const reason = json && typeof json.reason === 'string' ? json.reason : `server answered ${res.status}`
        return { ok: false, reason }
    }
    const result = {
        ok: true as const,
        data: json.data,
        pages: typeof json.pages === 'number' ? json.pages : undefined,
        bytes: typeof json.bytes === 'number' ? json.bytes : undefined,
        cached: json.cached === true,
    }
    renderMemo.set(payload, result)
    while (renderMemo.size > RENDER_MEMO_SIZE) renderMemo.delete(renderMemo.keys().next().value!)
    return result
}

export function clearGeminiPdfRenderMemo(): void {
    renderMemo.clear()
}

// Plan, render, splice. Never throws for a skip or a render failure: the
// caller always gets a sendable body (the original one when not applied). An
// abort during the render propagates so the request stops as it would anyway.
export async function applyGeminiPdfInput<T>(
    body: T,
    opts: { render?: GeminiPdfRenderer, signal?: AbortSignal } = {},
): Promise<GeminiPdfApplyResult<T>> {
    const plan = planGeminiPdfInput(body)
    if (plan.apply === false) {
        noteSkipped(plan.reason)
        return { body, applied: false, reason: plan.reason }
    }
    let rendered: GeminiPdfRenderResult
    try {
        rendered = await (opts.render ?? renderGeminiPdfOnServer)(plan.blocks, opts.signal)
    } catch (err) {
        if (opts.signal?.aborted) throw err
        rendered = { ok: false, reason: `render request failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (rendered.ok === false) {
        noteSkipped(rendered.reason)
        return { body, applied: false, reason: rendered.reason }
    }
    const next = buildGeminiPdfBody(body as JsonObject, plan, rendered.data) as T
    console.debug(`[GeminiPdfInput] sent ${plan.chars} characters of context as a ${rendered.pages ?? '?'}-page PDF`)
    return { body: next, applied: true, pages: rendered.pages }
}

// Native generateContent / streamGenerateContent endpoints (AI Studio, Vertex,
// custom base URLs). Other calls through the same fetch — cachedContents,
// countTokens — pass through untouched.
const NATIVE_GEMINI_CHAT_URL = /:(?:stream)?generateContent(?:[?#]|$)/i

// fetch wrapper for the model-preset path, where the adapter serializes the
// body itself: parses a native Gemini JSON body, applies the transform, and
// forwards the (possibly rewritten) request to the inner transport.
export function withGeminiPdfInput(fetchImpl: typeof fetch, opts: { render?: GeminiPdfRenderer } = {}): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (!NATIVE_GEMINI_CHAT_URL.test(url) || typeof init?.body !== 'string') return fetchImpl(input, init)
        let parsed: unknown
        try {
            parsed = JSON.parse(init.body)
        } catch {
            return fetchImpl(input, init)
        }
        const result = await applyGeminiPdfInput(parsed, { render: opts.render, signal: init.signal ?? undefined })
        if (!result.applied) return fetchImpl(input, init)
        return fetchImpl(input, { ...init, body: JSON.stringify(result.body) })
    }) as typeof fetch
}
