import { beforeEach, describe, expect, test, vi } from 'vitest'

// requestChatData runs the character's 'request' trigger on every request.
// Its Lua can write chat variables, so a side request (the BTW side chat)
// passes skipRequestTrigger. Driven through the real request loop with the
// built-in Echo model, so nothing leaves the process.

const mocks = vi.hoisted(() => {
    // Importing request.ts pulls in the stores, whose module effects read the
    // database once at load; give them an empty one.
    const emptyDb = () => ({ echoMessage: 'echoed', echoDelay: 0, requestRetrys: 0, fallbackModels: {}, enabledModules: [], personas: [], characters: [] })
    return {
        emptyDb,
        db: emptyDb() as any,
        runTrigger: vi.fn(),
        getCurrentCharacter: vi.fn(),
        getCurrentChat: vi.fn(() => ({ id: 'selected-chat', message: [] })),
    }
})

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
    getCurrentCharacter: mocks.getCurrentCharacter,
    getCurrentChat: mocks.getCurrentChat,
}))
vi.mock('../triggers', () => ({ runTrigger: mocks.runTrigger }))
vi.mock('../mcp/mcp', () => ({
    getTools: vi.fn(async () => []),
    callTool: vi.fn(),
    encodeToolCall: vi.fn(),
    decodeToolCall: vi.fn(),
}))
vi.mock('../../plugins/plugins.svelte', () => ({
    pluginProcess: vi.fn(),
    pluginV2: { replacerbeforeRequest: new Set(), replacerafterRequest: new Set() },
}))

import { requestChatData } from './request'

const ECHO_ROUTE = { kind: 'classic' as const, aiModel: 'echo_model', providerKey: 'classic:echo_model', fallbackModels: [] }

beforeEach(() => {
    mocks.db = mocks.emptyDb()
    mocks.runTrigger.mockReset()
    mocks.runTrigger.mockImplementation(async (_char, _mode, arg) => ({ displayData: arg.displayData }))
    mocks.getCurrentCharacter.mockReset()
    mocks.getCurrentChat.mockReset()
    mocks.getCurrentCharacter.mockReturnValue({ chaId: 'selected' })
    mocks.getCurrentChat.mockReturnValue({ id: 'selected-chat', message: [] })
})

describe('requestChatData request trigger', () => {
    test('runs the character request trigger by default', async () => {
        const char = { chaId: 'aria' } as any
        const result = await requestChatData({
            formated: [{ role: 'user', content: 'hi' }],
            bias: {},
            currentChar: char,
            routeSnapshot: ECHO_ROUTE,
            tools: [],
        }, 'otherAx')

        expect(result).toMatchObject({ type: 'success', result: 'echoed' })
        expect(mocks.runTrigger).toHaveBeenCalledTimes(1)
        expect(mocks.runTrigger.mock.calls[0][0]).toBe(char)
        expect(mocks.runTrigger.mock.calls[0][1]).toBe('request')
    })

    test('skipRequestTrigger runs no trigger, not even for the selected character', async () => {
        const result = await requestChatData({
            formated: [{ role: 'user', content: 'hi' }],
            bias: {},
            currentChar: { chaId: 'aria' } as any,
            routeSnapshot: ECHO_ROUTE,
            tools: [],
            skipRequestTrigger: true,
        }, 'otherAx')

        expect(result).toMatchObject({ type: 'success', result: 'echoed' })
        expect(mocks.runTrigger).not.toHaveBeenCalled()
        expect(mocks.getCurrentCharacter).not.toHaveBeenCalled()
    })
})
