import { beforeEach, describe, expect, it, vi } from 'vitest'

const binding = vi.hoisted(() => ({ value: { kind: 'classic' } as any }))
const mcps = vi.hoisted(() => ({ value: [] as string[] }))
const notifyInfo = vi.hoisted(() => vi.fn())
const db = vi.hoisted(() => ({ value: {} as any }))
const resolvedModes = vi.hoisted(() => [] as string[])

vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => db.value }))
vi.mock('../request/modelPresetBinding', () => ({
    resolveChatModelBinding: (_chat: unknown, mode: string) => { resolvedModes.push(mode); return binding.value },
    captureChatModelRoute: (_chat: unknown, mode: string) => ({ kind: 'classic', aiModel: mode }),
}))
vi.mock('../modules', () => ({ getModuleMcps: () => mcps.value, captureModuleRuntimeContext: () => ({}) }))
vi.mock('../../alert', () => ({ notifyInfo }))
vi.mock('src/lang', () => ({ language: { mcpToolsOff: 'tools off.', mcpToolsUnsupported: 'no tools.', mcpToolsWhereToTurnOn: 'turn on in the sidebar.' } }))

const { captureChatMainRoute, chatToolBlock, hasRisuAccessTools, mainRouteMode, presetSendsTools, presetToolsCapable, warnBlockedTools } = await import('./toolGate')

function preset(toolUse: boolean, caps: string[] = ['tools', 'streaming'], adapterKind = 'google-gemini') {
    return { toolUse, profileSnapshot: { adapterKind, capabilities: caps } } as any
}

beforeEach(() => {
    binding.value = { kind: 'classic' }
    mcps.value = []
    db.value = {}
    resolvedModes.length = 0
    notifyInfo.mockReset()
})

describe('whether a request carries tools', () => {
    it('needs a profile with tools and a tool-capable adapter', () => {
        expect(presetToolsCapable(preset(true))).toBe(true)
        expect(presetToolsCapable(preset(true, ['streaming']))).toBe(false)
        expect(presetToolsCapable(preset(true, ['tools'], 'novelai'))).toBe(false)
    })

    it("goes by the preset's switch, or the chat's for its main requests only", () => {
        expect(presetSendsTools(preset(true), null, 'otherAx')).toBe(true)
        expect(presetSendsTools(preset(false), null, 'model')).toBe(false)
        expect(presetSendsTools(preset(false), { nodeOnlyToolUse: true }, 'model')).toBe(true)
        expect(presetSendsTools(preset(false), { nodeOnlyToolUse: true }, 'otherAx')).toBe(false)
        expect(presetSendsTools(preset(false, ['streaming']), { nodeOnlyToolUse: true }, 'model')).toBe(false)
    })

    it('turns them on for the bot edit mode (the Risu Access tools in the request)', () => {
        expect(presetSendsTools(preset(false), null, 'model', true)).toBe(true)
        expect(presetSendsTools(preset(false), null, 'emotion', true)).toBe(false)
        expect(hasRisuAccessTools([{ name: 'x', mcpURL: 'internal:dice' }, { name: 'risu-get-character-info', mcpURL: 'internal:risuai' }])).toBe(true)
        expect(hasRisuAccessTools([{ name: 'x', mcpURL: 'internal:dice' }])).toBe(false)
        expect(hasRisuAccessTools(undefined)).toBe(false)
    })
})

describe("why a chat's main requests go without tools", () => {
    it('says nothing on the classic path, which always sends them', () => {
        expect(chatToolBlock({ id: 'c' } as any)).toBeNull()
    })

    it("tells the switch being off from the model not supporting tools", () => {
        binding.value = { kind: 'modelPreset', preset: preset(false) }
        expect(chatToolBlock({ id: 'c' } as any)).toBe('off')
        expect(chatToolBlock({ id: 'c', nodeOnlyToolUse: true } as any)).toBeNull()
        binding.value = { kind: 'modelPreset', preset: preset(true, ['streaming']) }
        expect(chatToolBlock({ id: 'c', nodeOnlyToolUse: true } as any)).toBe('unsupported')
    })
})

describe('the send notice', () => {
    it('says it once per chat, only with an MCP module on and tools off', () => {
        binding.value = { kind: 'modelPreset', preset: preset(false) }
        warnBlockedTools({ id: 'a' } as any, {} as any)
        expect(notifyInfo).not.toHaveBeenCalled()

        mcps.value = ['internal:dice']
        warnBlockedTools({ id: 'a' } as any, {} as any)
        warnBlockedTools({ id: 'a' } as any, {} as any)
        expect(notifyInfo).toHaveBeenCalledTimes(1)
        expect(notifyInfo).toHaveBeenCalledWith('tools off. turn on in the sidebar.')

        warnBlockedTools({ id: 'b', nodeOnlyToolUse: true } as any, {} as any)
        expect(notifyInfo).toHaveBeenCalledTimes(1)
    })

    it('says nothing for the Risu Access MCP, which turns tools on by itself', () => {
        binding.value = { kind: 'modelPreset', preset: preset(false) }
        mcps.value = ['internal:risuai']
        warnBlockedTools({ id: 'edit' } as any, {} as any)
        expect(notifyInfo).not.toHaveBeenCalled()
        expect(chatToolBlock({ id: 'edit' } as any, true)).toBeNull()
    })
})

describe('the model the bot edit mode goes to (2026-11-08)', () => {
    it('is the main model, or the sub model only with the edit mode on and the sub model picked', () => {
        expect(mainRouteMode(true)).toBe('model')
        db.value = { nodeOnlyEditModeModel: 'sub' }
        expect(mainRouteMode(true)).toBe('submodel')
        expect(mainRouteMode(false)).toBe('model')
        db.value = { nodeOnlyEditModeModel: 'main' }
        expect(mainRouteMode(true)).toBe('model')
    })

    it("captures a send's route there: the edit mode is the Risu Access module on", () => {
        db.value = { nodeOnlyEditModeModel: 'sub' }
        mcps.value = ['internal:dice']
        expect(captureChatMainRoute({} as any, { id: 'c' } as any)).toMatchObject({ aiModel: 'model' })
        mcps.value = ['internal:risuai']
        expect(captureChatMainRoute({} as any, { id: 'c' } as any)).toMatchObject({ aiModel: 'submodel' })
        expect(captureChatMainRoute({} as any, { id: 'c' } as any, {} as any)).toMatchObject({ aiModel: 'submodel' })
    })

    it("asks the sub model's preset whether the edit chat's requests carry tools", () => {
        db.value = { nodeOnlyEditModeModel: 'sub' }
        binding.value = { kind: 'modelPreset', preset: preset(false, ['streaming']) }
        expect(chatToolBlock({ id: 'edit' } as any, true)).toBe('unsupported')
        expect(chatToolBlock({ id: 'plain' } as any)).toBe('unsupported')
        expect(resolvedModes).toEqual(['submodel', 'model'])
    })
})
