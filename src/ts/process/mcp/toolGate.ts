// Whether a chat's main requests can carry MCP tools. A model preset sends
// them only with its "도구 사용" on, a profile declaring 'tools' and a
// tool-capable adapter (request.ts); the classic path always does. With an
// MCP module on and the switch off, the model was told about tools it could
// not call and answered that it could not edit (the user's report,
// 2026-10-28). A chat can turn tools on for its own main requests without
// touching the preset (the user's choice, 2026-10-28).
import { TOOL_CAPABLE_ADAPTER_KINDS, type ModelPreset } from 'src/ts/preset/types'
import type { Chat } from 'src/ts/storage/database.svelte'
import { language } from 'src/lang'
import { notifyInfo } from '../../alert'
import type { ModelModeExtended } from '../request/shared'
import { resolveChatModelBinding } from '../request/modelPresetBinding'
import { getModuleMcps, type ModuleRuntimeContext } from '../modules'

type ToolPreset = Pick<ModelPreset, 'toolUse' | 'profileSnapshot'>

/** The preset's model can call tools at all (its profile and adapter). */
export function presetToolsCapable(preset: ToolPreset): boolean {
    return TOOL_CAPABLE_ADAPTER_KINDS.includes(preset.profileSnapshot.adapterKind)
        && (preset.profileSnapshot.capabilities?.includes('tools') ?? false)
}

/** Tools go with this request: the preset's switch, or the chat's for its main requests. */
export function presetSendsTools(preset: ToolPreset, chat: Pick<Chat, 'nodeOnlyToolUse'> | null | undefined, mode: ModelModeExtended): boolean {
    const on = preset.toolUse === true || (mode === 'model' && chat?.nodeOnlyToolUse === true)
    return on && presetToolsCapable(preset)
}

/**
 * Why a chat's main requests go without tools: 'off' (the preset's switch
 * and the chat's are off), 'unsupported' (the model cannot call tools), or
 * null when they go (the classic path, or tools on).
 */
export type ToolBlock = 'off' | 'unsupported' | null

export function chatToolBlock(chat: Chat | null | undefined): ToolBlock {
    if (!chat) return null
    const binding = resolveChatModelBinding(chat, 'model')
    if (binding.kind !== 'modelPreset') return null
    if (!presetToolsCapable(binding.preset)) return 'unsupported'
    return presetSendsTools(binding.preset, chat, 'model') ? null : 'off'
}

/** What to say for a block (the sidebar and the send notice). */
export function toolBlockText(block: Exclude<ToolBlock, null>): string {
    return block === 'off' ? language.mcpToolsOff : language.mcpToolsUnsupported
}

const warnedChats = new Set<string>()

/** A send with an MCP module on and no tools: said once per chat while the app is open. */
export function warnBlockedTools(chat: Chat | null | undefined, moduleContext: ModuleRuntimeContext): void {
    if (!chat?.id || warnedChats.has(chat.id)) return
    if (getModuleMcps(moduleContext).length === 0) return
    const block = chatToolBlock(chat)
    if (!block) return
    warnedChats.add(chat.id)
    notifyInfo(`${toolBlockText(block)} ${language.mcpToolsWhereToTurnOn}`)
}
