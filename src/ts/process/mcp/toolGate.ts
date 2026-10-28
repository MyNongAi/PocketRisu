// Whether a chat's main requests can carry MCP tools. A model preset sends
// them only with its "도구 사용" on, a profile declaring 'tools' and a
// tool-capable adapter (request.ts); the classic path always does. With an
// MCP module on and the switch off, the model was told about tools it could
// not call and answered that it could not edit (the user's report,
// 2026-10-28). A chat turns tools on for its own main requests without
// touching the preset (the user's choice, 2026-10-28): by its own switch, or
// by having the Risu Access module on, which is the bot edit mode (editMode.ts).
import { TOOL_CAPABLE_ADAPTER_KINDS, type ModelPreset } from 'src/ts/preset/types'
import type { Chat } from 'src/ts/storage/database.svelte'
import { language } from 'src/lang'
import { notifyInfo } from '../../alert'
import type { ModelModeExtended } from '../request/shared'
import { resolveChatModelBinding } from '../request/modelPresetBinding'
import { getModuleMcps, type ModuleRuntimeContext } from '../modules'

/** The built-in Risu Access MCP: on for a chat, it is the bot edit mode. */
export const RISU_ACCESS_URL = 'internal:risuai'

type ToolPreset = Pick<ModelPreset, 'toolUse' | 'profileSnapshot'>

/** The preset's model can call tools at all (its profile and adapter). */
export function presetToolsCapable(preset: ToolPreset): boolean {
    return TOOL_CAPABLE_ADAPTER_KINDS.includes(preset.profileSnapshot.adapterKind)
        && (preset.profileSnapshot.capabilities?.includes('tools') ?? false)
}

/**
 * Tools go with this request: the preset's switch, or for a chat's main
 * requests its own switch or the edit mode (`editMode`: the Risu Access
 * module is on for it).
 */
export function presetSendsTools(
    preset: ToolPreset,
    chat: Pick<Chat, 'nodeOnlyToolUse'> | null | undefined,
    mode: ModelModeExtended,
    editMode = false,
): boolean {
    const on = preset.toolUse === true || (mode === 'model' && (chat?.nodeOnlyToolUse === true || editMode))
    return on && presetToolsCapable(preset)
}

/** The request's tools come from the Risu Access MCP, among others (getMCPTools marks each with its server). */
export function hasRisuAccessTools(tools: readonly unknown[] | null | undefined): boolean {
    return (tools ?? []).some((tool) => !!tool && typeof tool === 'object' && (tool as { mcpURL?: unknown }).mcpURL === RISU_ACCESS_URL)
}

/**
 * Why a chat's main requests go without tools: 'off' (the preset's switch
 * and the chat's are off), 'unsupported' (the model cannot call tools), or
 * null when they go (the classic path, or tools on).
 */
export type ToolBlock = 'off' | 'unsupported' | null

export function chatToolBlock(chat: Chat | null | undefined, editMode = false): ToolBlock {
    if (!chat) return null
    const binding = resolveChatModelBinding(chat, 'model')
    if (binding.kind !== 'modelPreset') return null
    if (!presetToolsCapable(binding.preset)) return 'unsupported'
    return presetSendsTools(binding.preset, chat, 'model', editMode) ? null : 'off'
}

/** What to say for a block (the sidebar and the send notice). */
export function toolBlockText(block: Exclude<ToolBlock, null>): string {
    return block === 'off' ? language.mcpToolsOff : language.mcpToolsUnsupported
}

const warnedChats = new Set<string>()

/** A send with an MCP module on and no tools: said once per chat while the app is open. */
export function warnBlockedTools(chat: Chat | null | undefined, moduleContext: ModuleRuntimeContext): void {
    if (!chat?.id || warnedChats.has(chat.id)) return
    const mcps = getModuleMcps(moduleContext)
    if (mcps.length === 0) return
    const block = chatToolBlock(chat, mcps.includes(RISU_ACCESS_URL))
    if (!block) return
    warnedChats.add(chat.id)
    notifyInfo(`${toolBlockText(block)} ${language.mcpToolsWhereToTurnOn}`)
}
