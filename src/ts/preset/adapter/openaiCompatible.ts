import type { ModelPreset } from '../types'
import { buildPreparedRequest } from './buildRequest'
import {
    ModelPresetAdapterError,
    normalizeFetchError,
    normalizeHttpStatus,
} from './error'
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

interface WireMessage {
    role: AdapterChatMessage['role']
    content: string
    name?: string
    tool_call_id?: string
}

export async function sendChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterChatResponse> {
    const prepared = prepareOpenAiBody(preset, options, credential, false)
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
        throw new ModelPresetAdapterError('parse', 'Failed to parse OpenAI-compatible JSON response', {
            cause: err,
        })
    }

    return parseChatCompletion(raw)
}

export async function* streamChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    const prepared = prepareOpenAiBody(preset, options, credential, true)
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
        throw new ModelPresetAdapterError('parse', 'OpenAI-compatible stream response has no body')
    }

    try {
        for await (const event of parseSseStream(response.body)) {
            if (event.data === '[DONE]') return
            if (event.data.length === 0) continue
            let raw: unknown
            try {
                raw = JSON.parse(event.data)
            } catch (err) {
                throw new ModelPresetAdapterError(
                    'parse',
                    'Failed to parse OpenAI-compatible stream chunk JSON',
                    { cause: err },
                )
            }
            const delta = parseChatStreamDelta(raw)
            if (delta) yield delta
        }
    } catch (err) {
        // Intentional domain errors (parse, etc.) pass through;
        // fetch/abort/network failures during stream body read get normalized.
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }
}

function prepareOpenAiBody(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential: AdapterCredential | undefined,
    stream: boolean,
): AdapterPreparedRequest {
    const prepared = buildPreparedRequest({ preset, credential })
    // messages and stream are wire invariants per plan §4-5 and must not be
    // overridden by customBody; assign them after the shared merge.
    prepared.body.messages = options.messages.map(toWireMessage)
    prepared.body.stream = stream
    return prepared
}

function toWireMessage(message: AdapterChatMessage): WireMessage {
    const wire: WireMessage = {
        role: message.role,
        content: message.content,
    }
    if (message.name !== undefined) wire.name = message.name
    if (message.toolCallId !== undefined) wire.tool_call_id = message.toolCallId
    return wire
}

async function deriveHttpError(response: Response): Promise<ModelPresetAdapterError> {
    let bodyText = ''
    try {
        bodyText = await response.text()
    } catch {
        // ignore body read failures; status alone is enough to classify
    }
    const message = extractErrorMessage(bodyText) ?? `HTTP ${response.status}`
    return normalizeHttpStatus(response.status, message)
        ?? new ModelPresetAdapterError('unknown', message, { status: response.status })
}

function extractErrorMessage(bodyText: string): string | null {
    if (!bodyText) return null
    try {
        const parsed = JSON.parse(bodyText) as { error?: { message?: unknown }; message?: unknown }
        if (typeof parsed?.error?.message === 'string') return parsed.error.message
        if (typeof parsed?.message === 'string') return parsed.message
    } catch {
        return bodyText.slice(0, 200)
    }
    return null
}

function parseChatCompletion(raw: unknown): AdapterChatResponse {
    if (!isPlainObject(raw)) {
        throw new ModelPresetAdapterError('parse', 'OpenAI-compatible response is not an object')
    }
    const choices = raw['choices']
    if (!Array.isArray(choices) || choices.length === 0) {
        throw new ModelPresetAdapterError(
            'parse',
            'OpenAI-compatible response has no choices',
        )
    }
    const first = choices[0]
    if (!isPlainObject(first)) {
        throw new ModelPresetAdapterError('parse', 'First choice is not an object')
    }
    const message = first['message']
    const text = isPlainObject(message) && typeof message['content'] === 'string'
        ? (message['content'] as string)
        : ''
    const finishReason = typeof first['finish_reason'] === 'string'
        ? (first['finish_reason'] as string)
        : undefined
    return {
        text,
        finishReason,
        usage: parseUsage(raw['usage']),
        raw,
    }
}

function parseChatStreamDelta(raw: unknown): AdapterChatStreamDelta | null {
    if (!isPlainObject(raw)) return null
    const choices = raw['choices']
    let textDelta = ''
    let finishReason: string | undefined
    if (Array.isArray(choices) && choices.length > 0 && isPlainObject(choices[0])) {
        const first = choices[0] as Record<string, unknown>
        const delta = first['delta']
        if (isPlainObject(delta) && typeof delta['content'] === 'string') {
            textDelta = delta['content'] as string
        }
        if (typeof first['finish_reason'] === 'string') {
            finishReason = first['finish_reason'] as string
        }
    }
    const usage = parseUsage(raw['usage'])
    if (textDelta.length === 0 && finishReason === undefined && usage === undefined) {
        return null
    }
    return { textDelta, finishReason, usage, raw }
}

function parseUsage(raw: unknown): AdapterUsage | undefined {
    if (!isPlainObject(raw)) return undefined
    const usage: AdapterUsage = {}
    if (typeof raw['prompt_tokens'] === 'number') usage.promptTokens = raw['prompt_tokens'] as number
    if (typeof raw['completion_tokens'] === 'number') {
        usage.completionTokens = raw['completion_tokens'] as number
    }
    if (typeof raw['total_tokens'] === 'number') usage.totalTokens = raw['total_tokens'] as number
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
