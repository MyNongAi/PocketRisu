import type { ModelPreset } from '../types'
import {
    ModelPresetAdapterError,
    extractErrorMessage,
    normalizeFetchError,
    normalizeHttpStatus,
} from './error'
import { prepareAdapterRequest } from './resolveCredential'
import { parseSseStream } from './sse'
import type {
    AdapterChatMessage,
    AdapterChatOptions,
    AdapterChatResponse,
    AdapterChatStreamDelta,
    AdapterCredential,
    AdapterPreparedRequest,
    AdapterUsage,
} from './types'
import { resolveWireModelId } from './wireInvariants'

interface GeminiPart {
    text: string
}

interface GeminiContent {
    role: 'user' | 'model'
    parts: GeminiPart[]
}

export async function sendGoogleChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterChatResponse> {
    const prepared = await prepareGeminiBody(preset, options, credential, false)
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    let response: Response
    try {
        response = await fetchImpl(prepared.url, {
            method: prepared.method,
            headers: prepared.headers,
            body: JSON.stringify(prepared.body),
            signal: options.abortSignal,
        })
    } catch (err) {
        throw normalizeFetchError(err)
    }

    if (!response.ok) {
        throw await deriveHttpError(response)
    }

    let raw: unknown
    try {
        raw = await response.json()
    } catch (err) {
        throw new ModelPresetAdapterError('parse', 'Failed to parse Gemini JSON response', {
            cause: err,
        })
    }

    return parseGeminiResponse(raw)
}

export async function* streamGoogleChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    const prepared = await prepareGeminiBody(preset, options, credential, true)
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    let response: Response
    try {
        response = await fetchImpl(prepared.url, {
            method: prepared.method,
            headers: { ...prepared.headers, Accept: 'text/event-stream' },
            body: JSON.stringify(prepared.body),
            signal: options.abortSignal,
        })
    } catch (err) {
        throw normalizeFetchError(err)
    }

    if (!response.ok) {
        throw await deriveHttpError(response)
    }

    if (!response.body) {
        throw new ModelPresetAdapterError('parse', 'Gemini stream response has no body')
    }

    try {
        for await (const event of parseSseStream(response.body)) {
            if (event.data.length === 0) continue
            let raw: unknown
            try {
                raw = JSON.parse(event.data)
            } catch (err) {
                throw new ModelPresetAdapterError(
                    'parse',
                    'Failed to parse Gemini stream chunk JSON',
                    { cause: err },
                )
            }
            const delta = parseGeminiStreamDelta(raw)
            if (delta) yield delta
        }
    } catch (err) {
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }
}

async function prepareGeminiBody(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential: AdapterCredential | undefined,
    stream: boolean,
): Promise<AdapterPreparedRequest> {
    const prepared = await prepareAdapterRequest({
        preset,
        credential,
        abortSignal: options.abortSignal,
    })
    // Wire invariants overwrite any customBody collisions (plan §4-5):
    //   - contents / systemInstruction → adapter owns the prompt structure
    //   - model (URL path)             → adapter selects the endpoint, not
    //                                    body.model (which Gemini ignores)
    // Resolve modelId from the preset's user values / schema, not the
    // customBody-merged body, so `customBody.model` cannot redirect the URL.
    const modelId = resolveWireModelId(preset, { vendorName: 'Google Gemini' })
    delete prepared.body.model

    const { system, chat } = collectSystemAndChat(options.messages)
    prepared.body.contents = chat.map(toGeminiContent)
    if (system.length > 0) {
        prepared.body.systemInstruction = { parts: [{ text: system }] }
    } else {
        delete prepared.body.systemInstruction
    }

    const suffix = stream ? ':streamGenerateContent?alt=sse' : ':generateContent'
    prepared.url = `${prepared.url}/${encodeURIComponent(modelId)}${suffix}`
    return prepared
}

function collectSystemAndChat(messages: AdapterChatMessage[]): {
    system: string
    chat: AdapterChatMessage[]
} {
    const systems: string[] = []
    const chat: AdapterChatMessage[] = []
    for (const message of messages) {
        if (message.role === 'system') {
            systems.push(message.content)
        } else if (message.role === 'tool') {
            // Gemini expresses tool results via `functionResponse` parts on
            // role `user`, not a `tool` role. Until the adapter actually
            // supports tool use, silently mapping tool → user would corrupt
            // the conversation. Surface it instead.
            throw new ModelPresetAdapterError(
                'unsupported',
                'Google Gemini adapter does not support tool-role messages yet',
            )
        } else {
            chat.push(message)
        }
    }
    return { system: systems.join('\n\n'), chat }
}

function toGeminiContent(message: AdapterChatMessage): GeminiContent {
    const role: GeminiContent['role'] = message.role === 'assistant' ? 'model' : 'user'
    return {
        role,
        parts: [{ text: message.content }],
    }
}

async function deriveHttpError(response: Response): Promise<ModelPresetAdapterError> {
    let bodyText = ''
    try {
        bodyText = await response.text()
    } catch {
        // ignore body read failures
    }
    const message = extractErrorMessage(bodyText) ?? `HTTP ${response.status}`
    return normalizeHttpStatus(response.status, message)
        ?? new ModelPresetAdapterError('unknown', message, { status: response.status })
}

function parseGeminiResponse(raw: unknown): AdapterChatResponse {
    if (!isPlainObject(raw)) {
        throw new ModelPresetAdapterError('parse', 'Gemini response is not an object')
    }
    const candidates = raw['candidates']
    if (!Array.isArray(candidates) || candidates.length === 0) {
        // Per Google docs, no-candidates responses signal that the prompt
        // itself was rejected. Surface promptFeedback.blockReason as a
        // non-retryable invalid-request rather than misclassifying as parser
        // failure (which would otherwise be retry/fallback eligible).
        throwIfPromptBlocked(raw['promptFeedback'])
        throw new ModelPresetAdapterError('parse', 'Gemini response has no candidates')
    }
    const first = candidates[0]
    if (!isPlainObject(first)) {
        throw new ModelPresetAdapterError('parse', 'First Gemini candidate is not an object')
    }
    const text = extractTextFromContent(first['content'])
    const finishReason = typeof first['finishReason'] === 'string'
        ? (first['finishReason'] as string)
        : undefined
    return {
        text,
        finishReason,
        usage: parseGeminiUsage(raw['usageMetadata']),
        raw,
    }
}

function parseGeminiStreamDelta(raw: unknown): AdapterChatStreamDelta | null {
    if (!isPlainObject(raw)) return null
    // Surface stream-level prompt blocks the same way as non-stream so the
    // user sees a real error instead of an empty stream that ends silently.
    throwIfPromptBlocked(raw['promptFeedback'])
    const candidates = raw['candidates']
    let textDelta = ''
    let finishReason: string | undefined
    if (Array.isArray(candidates) && candidates.length > 0 && isPlainObject(candidates[0])) {
        const first = candidates[0] as Record<string, unknown>
        textDelta = extractTextFromContent(first['content'])
        if (typeof first['finishReason'] === 'string') {
            finishReason = first['finishReason'] as string
        }
    }
    const usage = parseGeminiUsage(raw['usageMetadata'])
    if (textDelta.length === 0 && finishReason === undefined && usage === undefined) {
        return null
    }
    return { textDelta, finishReason, usage, raw }
}

function throwIfPromptBlocked(feedback: unknown): void {
    if (!isPlainObject(feedback)) return
    const reason = feedback['blockReason']
    if (typeof reason !== 'string' || reason.length === 0) return
    const message = typeof feedback['blockReasonMessage'] === 'string' && (feedback['blockReasonMessage'] as string).length > 0
        ? (feedback['blockReasonMessage'] as string)
        : reason
    throw new ModelPresetAdapterError(
        'invalid-request',
        `Gemini blocked the prompt: ${message}`,
        { retryable: false, fallbackEligible: false },
    )
}

function extractTextFromContent(content: unknown): string {
    if (!isPlainObject(content)) return ''
    const parts = content['parts']
    if (!Array.isArray(parts)) return ''
    let text = ''
    for (const part of parts) {
        if (isPlainObject(part) && typeof part['text'] === 'string') {
            text += part['text'] as string
        }
    }
    return text
}

function parseGeminiUsage(raw: unknown): AdapterUsage | undefined {
    if (!isPlainObject(raw)) return undefined
    const usage: AdapterUsage = {}
    if (typeof raw['promptTokenCount'] === 'number') {
        usage.promptTokens = raw['promptTokenCount'] as number
    }
    if (typeof raw['candidatesTokenCount'] === 'number') {
        usage.completionTokens = raw['candidatesTokenCount'] as number
    }
    if (typeof raw['totalTokenCount'] === 'number') {
        usage.totalTokens = raw['totalTokenCount'] as number
    }
    if (
        usage.promptTokens === undefined
        && usage.completionTokens === undefined
        && usage.totalTokens === undefined
    ) {
        return undefined
    }
    return usage
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
