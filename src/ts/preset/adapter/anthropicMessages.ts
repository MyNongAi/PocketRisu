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

// `anthropic` base provider v2+ supplies `max_tokens: 4096` via `defaultBody`,
// so freshly-resolved snapshots already carry the value. But presets persisted
// under an older snapshot (v1, `defaults: {}`) won't pick up the new default
// until they are re-resolved against the registry — and the profile version
// did not change (only the base provider did), so the profile-update detection
// will not flag them. Keep an adapter-side safety net for stale snapshots so
// existing chats keep working. `=== undefined` preserves any explicit 0 or
// negative override.
const ANTHROPIC_FALLBACK_MAX_TOKENS = 4096

interface AnthropicContentBlock {
    type: 'text'
    text: string
}

interface AnthropicWireMessage {
    role: 'user' | 'assistant'
    content: AnthropicContentBlock[]
}

export async function sendAnthropicChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterChatResponse> {
    const prepared = await prepareAnthropicBody(preset, options, credential, false)
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
        throw new ModelPresetAdapterError('parse', 'Failed to parse Anthropic JSON response', {
            cause: err,
        })
    }

    return parseAnthropicMessage(raw)
}

export async function* streamAnthropicChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    const prepared = await prepareAnthropicBody(preset, options, credential, true)
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
        throw new ModelPresetAdapterError('parse', 'Anthropic stream response has no body')
    }

    try {
        for await (const event of parseSseStream(response.body)) {
            if (event.event === 'ping') continue
            if (event.event === 'message_stop') return
            if (event.event === 'error') {
                throw deriveStreamError(event.data)
            }
            if (event.data.length === 0) continue
            let raw: unknown
            try {
                raw = JSON.parse(event.data)
            } catch (err) {
                throw new ModelPresetAdapterError(
                    'parse',
                    'Failed to parse Anthropic stream chunk JSON',
                    { cause: err },
                )
            }
            const delta = parseAnthropicStreamDelta(event.event, raw)
            if (delta) yield delta
        }
    } catch (err) {
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }
}

async function prepareAnthropicBody(
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
    //   - messages / system  → adapter owns the prompt structure
    //   - model              → adapter selects the wire model id
    //   - stream             → adapter controls the transport mode
    const modelId = resolveWireModelId(preset, { vendorName: 'Anthropic' })
    const { system, chat } = collectSystemAndChat(options.messages)
    prepared.body.messages = chat.map(toAnthropicMessage)
    if (system.length > 0) {
        prepared.body.system = system
    } else {
        delete prepared.body.system
    }
    prepared.body.model = modelId
    if (prepared.body.max_tokens === undefined) {
        prepared.body.max_tokens = ANTHROPIC_FALLBACK_MAX_TOKENS
    }
    prepared.body.stream = stream
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
            // Tool messages need a different wire shape on Anthropic
            // (`tool_result` content blocks). Until the adapter actually
            // supports tool use, silently mapping tool → user would corrupt
            // the conversation. Surface it instead.
            throw new ModelPresetAdapterError(
                'unsupported',
                'Anthropic adapter does not support tool-role messages yet',
            )
        } else {
            chat.push(message)
        }
    }
    return { system: systems.join('\n\n'), chat }
}

function toAnthropicMessage(message: AdapterChatMessage): AnthropicWireMessage {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    return {
        role,
        content: [{ type: 'text', text: message.content }],
    }
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

function deriveStreamError(data: string): ModelPresetAdapterError {
    let message = 'Anthropic stream error'
    try {
        const parsed = JSON.parse(data) as { error?: { message?: unknown; type?: unknown } }
        if (typeof parsed?.error?.message === 'string') message = parsed.error.message
    } catch {
        // fall through with default message
    }
    return new ModelPresetAdapterError('server', message)
}

function parseAnthropicMessage(raw: unknown): AdapterChatResponse {
    if (!isPlainObject(raw)) {
        throw new ModelPresetAdapterError('parse', 'Anthropic response is not an object')
    }
    const content = raw['content']
    let text = ''
    if (Array.isArray(content)) {
        for (const block of content) {
            if (isPlainObject(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
                text += block['text'] as string
            }
        }
    }
    const finishReason = typeof raw['stop_reason'] === 'string'
        ? (raw['stop_reason'] as string)
        : undefined
    return {
        text,
        finishReason,
        usage: parseAnthropicUsage(raw['usage']),
        raw,
    }
}

function parseAnthropicStreamDelta(eventName: string | undefined, raw: unknown): AdapterChatStreamDelta | null {
    if (!isPlainObject(raw)) return null
    if (eventName === 'content_block_delta') {
        const delta = raw['delta']
        if (isPlainObject(delta) && delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            return { textDelta: delta['text'] as string, raw }
        }
        return null
    }
    if (eventName === 'message_delta') {
        const delta = raw['delta']
        const finishReason = isPlainObject(delta) && typeof delta['stop_reason'] === 'string'
            ? (delta['stop_reason'] as string)
            : undefined
        const usage = parseAnthropicUsage(raw['usage'])
        if (finishReason === undefined && usage === undefined) return null
        return { textDelta: '', finishReason, usage, raw }
    }
    return null
}

function parseAnthropicUsage(raw: unknown): AdapterUsage | undefined {
    if (!isPlainObject(raw)) return undefined
    const usage: AdapterUsage = {}
    if (typeof raw['input_tokens'] === 'number') usage.promptTokens = raw['input_tokens'] as number
    if (typeof raw['output_tokens'] === 'number') usage.completionTokens = raw['output_tokens'] as number
    if (
        usage.promptTokens === undefined
        && usage.completionTokens === undefined
    ) {
        return undefined
    }
    if (usage.promptTokens !== undefined && usage.completionTokens !== undefined) {
        usage.totalTokens = usage.promptTokens + usage.completionTokens
    }
    return usage
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
