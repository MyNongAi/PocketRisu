import { beforeEach, describe, expect, it, vi } from 'vitest'

const binding = vi.hoisted(() => ({ value: { kind: 'classic' } as any }))
const mcps = vi.hoisted(() => ({ value: [] as string[] }))
const notifyInfo = vi.hoisted(() => vi.fn())

vi.mock('../request/modelPresetBinding', () => ({ resolveChatModelBinding: () => binding.value }))
vi.mock('../modules', () => ({ getModuleMcps: () => mcps.value }))
vi.mock('../../alert', () => ({ notifyInfo }))
vi.mock('src/lang', () => ({ language: { mcpToolsOff: 'tools off.', mcpToolsUnsupported: 'no tools.', mcpToolsWhereToTurnOn: 'turn on in the sidebar.' } }))

const { chatToolBlock, hasRisuAccessTools, presetSendsTools, presetToolsCapable, warnBlockedTools } = await import('./toolGate')

function preset(toolUse: boolean, caps: string[] = ['tools', 'streaming'], adapterKind = 'google-gemini') {
    return { toolUse, profileSnapshot: { adapterKind, capabilities: caps } } as any
}

beforeEach(() => {
    binding.value = { kind: 'classic' }
    mcps.value = []
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
