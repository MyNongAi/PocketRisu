import { beforeEach, describe, expect, test, vi } from 'vitest'

// A request refused for ending on the model's turn is refused the same way
// every time. With requestRetrys 30, one HypaV3 summary went out 31 times
// before memory/trailingPrefill.ts resent it ending on a user turn (the
// user's log, 2026-10-26). Driven through the real request loop with a
// plugin provider standing in for the model, so nothing leaves the process.

const mocks = vi.hoisted(() => {
    const emptyDb = () => ({ requestRetrys: 30, fallbackModels: {}, enabledModules: [], personas: [], characters: [], temperature: 80, PresensePenalty: 0, frequencyPenalty: 0 })
    return {
        emptyDb,
        db: emptyDb() as any,
        provider: vi.fn(),
    }
})

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
    getCurrentCharacter: () => null,
    getCurrentChat: () => ({ id: 'selected-chat', message: [] }),
}))
vi.mock('../triggers', () => ({ runTrigger: vi.fn() }))
vi.mock('src/ts/requestLog', async (importOriginal) => ({ ...await importOriginal<object>(), recordRequestLog: vi.fn() }))
vi.mock('../mcp/mcp', () => ({
    getTools: vi.fn(async () => []),
    callTool: vi.fn(),
    encodeToolCall: vi.fn(),
    decodeToolCall: vi.fn(),
}))
vi.mock('../../plugins/plugins.svelte', () => ({
    pluginProcess: vi.fn(),
    pluginV2: {
        replacerbeforeRequest: new Set(),
        replacerafterRequest: new Set(),
        providers: new Map([['Flash', (...args: unknown[]) => mocks.provider(...args)]]),
    },
}))

import { requestChatData } from './request'
import { sendAllowingPrefillRefusal } from '../memory/trailingPrefill'
import { customV3ProviderMetaStore } from 'src/ts/plugins/apiV3/v3.svelte'
import { LLMFormat, LLMProvider, LLMTokenizer } from 'src/ts/model/modellist'

// What a loaded plugin registers for its provider (apiV3/v3.svelte.ts).
customV3ProviderMetaStore.push({
    id: 'pluginmodel:::Flash', name: 'Flash', shortName: 'Flash', fullName: 'Flash', internalID: 'pluginmodel:::Flash',
    provider: LLMProvider.AsIs, format: LLMFormat.Plugin, flags: [], parameters: ['temperature'], tokenizer: LLMTokenizer.Unknown,
})

const PLUGIN_ROUTE = { kind: 'classic' as const, aiModel: 'pluginmodel:::Flash', providerKey: 'classic:pluginmodel:::Flash', fallbackModels: [] }
const REFUSAL = 'Gemini API error 400: { "error": { "code": 400, "message": "Requests ending with a model turn are not supported.", "status": "INVALID_ARGUMENT" } }'

const send = (formated: { role: 'user' | 'assistant' | 'system', content: string }[]) => requestChatData({
    formated,
    bias: {},
    useStreaming: false,
    noMultiGen: true,
    routeSnapshot: PLUGIN_ROUTE,
    skipRequestTrigger: true,
    tools: [],
}, 'memory')

// getModelInfo clones the (missing) built-in entry of a plugin model:
// structuredClone takes undefined, the setup's JSON stand-in does not.
vi.stubGlobal('safeStructuredClone', (v: unknown) => v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

beforeEach(() => {
    mocks.db = mocks.emptyDb()
    mocks.provider.mockReset()
    mocks.provider.mockImplementation(async (arg: { prompt_chat: { role: string }[] }) => arg.prompt_chat.at(-1)?.role === 'assistant'
        ? { success: false, content: REFUSAL }
        : { success: true, content: 'summary' })
})

describe('a refused trailing prefill', () => {
    test('is not retried: one refusal, then the resend ending on a user turn', async () => {
        const result = await sendAllowingPrefillRefusal([
            { role: 'user', content: 'messages' },
            { role: 'assistant', content: 'Understood.' },
        ], send)

        expect(result).toMatchObject({ type: 'success', result: 'summary' })
        expect(mocks.provider).toHaveBeenCalledTimes(2)
        expect(mocks.provider.mock.calls[1][0].prompt_chat.at(-1).role).toBe('user')
    })

    test('other failures still take the retries', async () => {
        mocks.db.requestRetrys = 2
        mocks.provider.mockImplementation(async () => ({ success: false, content: 'Gemini API error 503: overloaded' }))

        const result = await send([{ role: 'user', content: 'messages' }])

        expect(result.type).toBe('fail')
        expect(mocks.provider).toHaveBeenCalledTimes(3)
    })
})
