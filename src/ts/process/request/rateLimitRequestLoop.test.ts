import { beforeEach, describe, expect, test, vi } from 'vitest'

// A 429 does not spend requestRetrys: the real request loop waits and sends
// again until the 429 time budget runs out (rateLimitRetry.ts; 2026-11-09,
// the user pressed send again after every 429). A plugin provider stands in
// for the model, so nothing leaves the process, and the waits advance a fake
// clock instead of sleeping.

const mocks = vi.hoisted(() => {
    const emptyDb = () => ({ requestRetrys: 0, nodeOnlyRateLimitWaitMinutes: 5, fallbackModels: {}, enabledModules: [], personas: [], characters: [], temperature: 80, PresensePenalty: 0, frequencyPenalty: 0 })
    return {
        emptyDb,
        db: emptyDb() as any,
        provider: vi.fn(),
        clock: { now: 1_000_000 },
        waits: [] as number[],
        stopDuringWait: null as AbortController | null,
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
vi.mock('./rateLimitRetry', async (importOriginal) => {
    const real = await importOriginal<typeof import('./rateLimitRetry')>()
    return {
        ...real,
        waitUnlessAborted: vi.fn(async (ms: number, signal?: AbortSignal | null) => {
            mocks.waits.push(ms)
            mocks.clock.now += ms
            mocks.stopDuringWait?.abort()
            return !signal?.aborted
        }),
    }
})

import { requestChatData } from './request'
import { customV3ProviderMetaStore } from 'src/ts/plugins/apiV3/v3.svelte'
import { LLMFormat, LLMProvider, LLMTokenizer } from 'src/ts/model/modellist'

customV3ProviderMetaStore.push({
    id: 'pluginmodel:::Flash', name: 'Flash', shortName: 'Flash', fullName: 'Flash', internalID: 'pluginmodel:::Flash',
    provider: LLMProvider.AsIs, format: LLMFormat.Plugin, flags: [], parameters: ['temperature'], tokenizer: LLMTokenizer.Unknown,
})

const PLUGIN_ROUTE = { kind: 'classic' as const, aiModel: 'pluginmodel:::Flash', providerKey: 'classic:pluginmodel:::Flash', fallbackModels: [] }
const EXHAUSTED = '{"error":{"code":429,"message":"Resource exhausted. Please try again later.","status":"RESOURCE_EXHAUSTED"}}'

const send = (abortSignal: AbortSignal | null = null) => requestChatData({
    formated: [{ role: 'user', content: 'hello' }],
    bias: {},
    useStreaming: false,
    noMultiGen: true,
    routeSnapshot: PLUGIN_ROUTE,
    skipRequestTrigger: true,
    tools: [],
}, 'model', abortSignal)

vi.stubGlobal('safeStructuredClone', (v: unknown) => v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

beforeEach(() => {
    mocks.db = mocks.emptyDb()
    mocks.provider.mockReset()
    mocks.waits = []
    mocks.clock.now = 1_000_000
    mocks.stopDuringWait = null
    vi.spyOn(Date, 'now').mockImplementation(() => mocks.clock.now)
})

describe('a 429 in the request loop', () => {
    test('is sent again after growing waits, without spending requestRetrys', async () => {
        let calls = 0
        mocks.provider.mockImplementation(async () => (++calls <= 3 ? { success: false, content: EXHAUSTED } : { success: true, content: 'reply' }))

        const result = await send()

        expect(result).toMatchObject({ type: 'success', result: 'reply' })
        expect(mocks.provider).toHaveBeenCalledTimes(4)
        expect(mocks.waits).toEqual([1000, 2000, 4000])
    })

    test('gives up once the time budget is spent, without count retries after it', async () => {
        mocks.db.requestRetrys = 30
        mocks.db.nodeOnlyRateLimitWaitMinutes = 1
        mocks.provider.mockImplementation(async () => ({ success: false, content: EXHAUSTED }))

        const result = await send()

        expect(result.type).toBe('fail')
        // 1+2+4+8+15+30 = 60 s fits in the minute; one more 30 s wait would not.
        expect(mocks.waits).toEqual([1000, 2000, 4000, 8000, 15000, 30000])
        expect(mocks.provider).toHaveBeenCalledTimes(7)
    })

    test('turned off (0 minutes), it falls back to the retry count', async () => {
        mocks.db.requestRetrys = 2
        mocks.db.nodeOnlyRateLimitWaitMinutes = 0
        mocks.provider.mockImplementation(async () => ({ success: false, content: EXHAUSTED }))

        const result = await send()

        expect(result.type).toBe('fail')
        expect(mocks.waits).toEqual([])
        expect(mocks.provider).toHaveBeenCalledTimes(3)
    })

    test('the stop button ends the wait', async () => {
        const controller = new AbortController()
        mocks.stopDuringWait = controller
        mocks.provider.mockImplementation(async () => ({ success: false, content: EXHAUSTED }))

        const result = await send(controller.signal)

        expect(result).toMatchObject({ type: 'fail', result: 'Aborted' })
        expect(mocks.provider).toHaveBeenCalledTimes(1)
    })

    test('other failures still use the retry count, with no waits', async () => {
        mocks.db.requestRetrys = 2
        mocks.provider.mockImplementation(async () => ({ success: false, content: 'Gemini API error 400: blocked' }))

        const result = await send()

        expect(result.type).toBe('fail')
        expect(mocks.waits).toEqual([])
        expect(mocks.provider).toHaveBeenCalledTimes(3)
    })
})
