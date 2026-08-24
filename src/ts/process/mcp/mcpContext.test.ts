import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => ({}) }))
vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: { authRefreshes: [] } } }))
vi.mock('src/ts/util', () => ({ sleep: async () => undefined }))
vi.mock('src/ts/globalApi.svelte', () => ({
    fetchNative: vi.fn(),
    openURL: vi.fn(),
}))
vi.mock('src/ts/alert', () => ({
    alertInput: async () => '',
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
}))
vi.mock('src/ts/storage/persistentKv', () => ({
    makeEncodedStorageKey: (...parts:string[]) => parts.join(':'),
    readPersistentJson: async () => undefined,
    writePersistentJson: async () => undefined,
}))
vi.mock('./pluginmcp', () => ({ registeredCustomPluginMCPs: new Map() }))
vi.mock('../modules', () => ({
    getModuleMcps: (context?:ModuleRuntimeContext) => (
        (context?.modules ?? []).map((module) => module.mcp?.url).filter(Boolean)
    ),
}))

import { MCPs, callMCPTool, getMCPTools } from './mcp'
import type { ModuleRuntimeContext, RisuModule } from '../modules'

function context(url:string):ModuleRuntimeContext {
    return {
        character: { chaId: `char-${url}` } as any,
        chat: { id: `chat-${url}`, message: [], note: '', name: '', localLore: [] },
        modules: [{ id: `module-${url}`, name: url, description: '', mcp: { url } } as RisuModule],
    }
}

function fakeClient(label:string) {
    return {
        getToolList: vi.fn(async () => [{ name: 'same-name', description: label, inputSchema: {} }]),
        callTool: vi.fn(async () => [{ type: 'text', text: label }]),
        destroy: vi.fn(),
    } as any
}

afterEach(() => {
    for(const key of Object.keys(MCPs)) delete MCPs[key]
})

describe('request-scoped MCP modules', () => {
    test('keeps simultaneous chat tool lists separate and executes the captured server', async () => {
        const clientA = fakeClient('A')
        const clientB = fakeClient('B')
        MCPs['plugin:a'] = clientA
        MCPs['plugin:b'] = clientB

        const toolsA = await getMCPTools(undefined, context('plugin:a'))
        const toolsB = await getMCPTools(undefined, context('plugin:b'))

        expect(toolsA).toEqual([expect.objectContaining({ name: 'same-name', mcpURL: 'plugin:a' })])
        expect(toolsB).toEqual([expect.objectContaining({ name: 'same-name', mcpURL: 'plugin:b' })])
        expect(clientA.destroy).not.toHaveBeenCalled()
        expect(await callMCPTool('same-name', {}, 'plugin:a')).toEqual([{ type: 'text', text: 'A' }])
        expect(clientA.callTool).toHaveBeenCalledOnce()
        expect(clientB.callTool).not.toHaveBeenCalled()
    })
})
