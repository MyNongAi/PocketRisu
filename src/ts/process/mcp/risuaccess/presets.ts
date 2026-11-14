import { getDatabase, type botPreset } from 'src/ts/storage/database.svelte'
import type { PromptItem } from 'src/ts/process/prompt'
import { MCPToolHandler, type MCPTool, type RPCToolCallContent } from '../mcplib'
import { mcpWriteAccess, type WriteAccess } from './writeAccess'

const response = (value: unknown): RPCToolCallContent[] => [{ type: 'text', text: JSON.stringify(value) }]
const error = (message: string): RPCToolCallContent[] => [{ type: 'text', text: `Error: ${message}` }]
const types = new Set(['plain', 'jailbreak', 'cot', 'chatML', 'persona', 'description', 'lorebook', 'postEverything', 'memory', 'authornote', 'chat', 'cache'])
const roles = new Set(['user', 'bot', 'system'])

function selected(index: unknown, name: unknown): { index: number, preset: botPreset, active: boolean } | null {
  const db = getDatabase()
  const found = Number.isInteger(index) ? Number(index)
    : typeof name === 'string' ? db.botPresets.findIndex((preset) => preset.name === name) : -1
  const preset = db.botPresets?.[found]
  return preset ? { index: found, preset, active: found === db.botPresetsId } : null
}

function fields(target: { index: number, preset: botPreset, active: boolean }) {
  const db = getDatabase()
  const source = target.active ? db : target.preset
  return {
    promptTemplate: source.promptTemplate ?? null,
    mainPrompt: source.mainPrompt,
    jailbreak: source.jailbreak,
    globalNote: source.globalNote,
    customPromptTemplateToggle: source.customPromptTemplateToggle ?? '',
  }
}

function buildItem(data: Record<string, unknown>, old?: PromptItem): PromptItem {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('item data must be an object')
  const type = data.type ?? old?.type
  if (typeof type !== 'string' || !types.has(type)) throw new Error('invalid prompt item type')
  // Fields this tool does not know (a later upstream or plugin addition) stay on an item of the same type.
  const base: Record<string, unknown> = old?.type === type ? old as unknown as Record<string, unknown> : {}
  const value = { ...base, ...data }
  if (data.comment !== undefined && data.name === undefined) value.name = data.comment
  if (value.name !== undefined && typeof value.name !== 'string') throw new Error('name must be text')
  const name = value.name as string | undefined
  if (type === 'plain' || type === 'jailbreak' || type === 'cot') {
    if (value.text !== undefined && typeof value.text !== 'string') throw new Error('text must be text')
    if (value.role !== undefined && !roles.has(String(value.role))) throw new Error('invalid role')
    if (value.type2 !== undefined && !['normal', 'globalNote', 'main'].includes(String(value.type2))) throw new Error('invalid type2')
    return { ...base, type, type2: (value.type2 ?? 'normal') as 'normal', text: (value.text ?? '') as string, role: (value.role ?? 'system') as 'system', name }
  }
  if (type === 'chatML') {
    if (value.text !== undefined && typeof value.text !== 'string') throw new Error('text must be text')
    return { ...base, type, text: (value.text ?? '') as string, name }
  }
  if (type === 'chat') {
    if (value.rangeStart !== undefined && !Number.isInteger(value.rangeStart)) throw new Error('invalid rangeStart')
    if (value.rangeEnd !== undefined && value.rangeEnd !== 'end' && !Number.isInteger(value.rangeEnd)) throw new Error('invalid rangeEnd')
    return { ...base, type, rangeStart: (value.rangeStart ?? 0) as number, rangeEnd: (value.rangeEnd ?? 'end') as number | 'end', chatAsOriginalOnSystem: value.chatAsOriginalOnSystem as boolean | undefined, name }
  }
  if (type === 'cache') {
    if (value.role !== undefined && !['user', 'assistant', 'system', 'all'].includes(String(value.role))) throw new Error('invalid cache role')
    if (value.depth !== undefined && !Number.isInteger(value.depth)) throw new Error('invalid depth')
    return { ...base, type, name: name ?? '', depth: (value.depth ?? 0) as number, role: (value.role ?? 'all') as 'all' }
  }
  if (data.text !== undefined && data.innerFormat === undefined) value.innerFormat = data.text
  if (data.role !== undefined && data.role2 === undefined) value.role2 = data.role
  if (value.innerFormat !== undefined && typeof value.innerFormat !== 'string') throw new Error('innerFormat must be text')
  if (value.role2 !== undefined && !roles.has(String(value.role2))) throw new Error('invalid role2')
  if (type === 'authornote') {
    if (value.defaultText !== undefined && typeof value.defaultText !== 'string') throw new Error('defaultText must be text')
    return { ...base, type, innerFormat: value.innerFormat as string | undefined, defaultText: value.defaultText as string | undefined, role2: value.role2 as 'system' | undefined, name }
  }
  return { ...base, type: type as 'persona', innerFormat: value.innerFormat as string | undefined, role2: value.role2 as 'system' | undefined, name }
}

export class PresetHandler extends MCPToolHandler {
  constructor(private readonly writeAccess: WriteAccess = mcpWriteAccess) { super() }

  getTools(): MCPTool[] {
    const selector = { index: { type: 'integer', description: 'Zero-based preset index.' }, name: { type: 'string', description: 'Preset name, used when index is omitted.' } }
    const item = { ...selector, itemIndex: { type: 'integer', description: 'Zero-based prompt item index.' } }
    return [
      { name: 'risu-list-prompt-presets', description: 'List prompt preset names and counts without prompt text.', inputSchema: { type: 'object', properties: {} } },
      { name: 'risu-get-prompt-preset', description: 'Read one prompt preset. Prompt items are paged; fields and toggle template are included.', inputSchema: { type: 'object', properties: { ...selector, offset: { type: 'integer' }, limit: { type: 'integer', maximum: 50 } } } },
      { name: 'risu-set-prompt-preset-item', description: 'Replace fields of a prompt template item.', inputSchema: { type: 'object', properties: { ...item, data: { type: 'object', description: 'Fields to change: type, text, innerFormat, role, role2, name, type2, or type-specific fields.' } }, required: ['itemIndex', 'data'] } },
      { name: 'risu-insert-prompt-preset-item', description: 'Insert an item at itemIndex.', inputSchema: { type: 'object', properties: { ...item, data: { type: 'object', description: 'New prompt item fields, including type.' } }, required: ['itemIndex', 'data'] } },
      { name: 'risu-delete-prompt-preset-item', description: 'Delete a prompt template item.', inputSchema: { type: 'object', properties: item, required: ['itemIndex'] } },
      { name: 'risu-set-prompt-preset-toggles', description: 'Replace the preset toggle template.', inputSchema: { type: 'object', properties: { ...selector, text: { type: 'string' } }, required: ['text'] } },
      { name: 'risu-set-prompt-preset-field', description: 'Replace mainPrompt, jailbreak or globalNote.', inputSchema: { type: 'object', properties: { ...selector, field: { type: 'string', enum: ['mainPrompt', 'jailbreak', 'globalNote'] }, text: { type: 'string' } }, required: ['field', 'text'] } },
    ]
  }

  async handle(tool: string, args: Record<string, unknown>): Promise<RPCToolCallContent[] | null> {
    if (!this.getTools().some((entry) => entry.name === tool)) return null
    const db = getDatabase()
    if (tool === 'risu-list-prompt-presets') return response((db.botPresets ?? []).map((preset, index) => {
      const view = fields({ index, preset, active: index === db.botPresetsId })
      return { index, name: preset.name ?? '', active: index === db.botPresetsId, promptItems: view.promptTemplate?.length ?? 0, hasToggleTemplate: view.customPromptTemplateToggle.length > 0 }
    }))
    const target = selected(args?.index, args?.name)
    if (!target) return error('prompt preset not found; provide index or name')
    const view = fields(target)
    if (tool === 'risu-get-prompt-preset') {
      const offset = Math.max(0, Number.isInteger(args.offset) ? Number(args.offset) : 0)
      const limit = Math.min(50, Math.max(1, Number.isInteger(args.limit) ? Number(args.limit) : 20))
      return response({ index: target.index, name: target.preset.name ?? '', active: target.active,
        totalItems: view.promptTemplate?.length ?? 0, offset, items: (view.promptTemplate ?? []).slice(offset, offset + limit).map((entry, at) => ({ index: offset + at, ...entry })),
        mainPrompt: view.mainPrompt, jailbreak: view.jailbreak, globalNote: view.globalNote, customPromptTemplateToggle: view.customPromptTemplateToggle })
    }
    const itemIndex = args.itemIndex
    if (['risu-set-prompt-preset-item', 'risu-delete-prompt-preset-item'].includes(tool)
      && (!Number.isInteger(itemIndex) || Number(itemIndex) < 0 || Number(itemIndex) >= (view.promptTemplate?.length ?? 0))) return error('prompt item index out of range')
    if (tool === 'risu-insert-prompt-preset-item' && (!Number.isInteger(itemIndex) || Number(itemIndex) < 0 || Number(itemIndex) > (view.promptTemplate?.length ?? 0))) return error('prompt item index out of range')
    if (tool === 'risu-set-prompt-preset-toggles' && typeof args.text !== 'string') return error('text is required')
    if (tool === 'risu-set-prompt-preset-field' && (!['mainPrompt', 'jailbreak', 'globalNote'].includes(String(args.field)) || typeof args.text !== 'string')) return error('valid field and text are required')
    let nextItem: PromptItem | undefined
    if (tool === 'risu-set-prompt-preset-item' || tool === 'risu-insert-prompt-preset-item') {
      try { nextItem = buildItem(args.data as Record<string, unknown>, tool === 'risu-set-prompt-preset-item' ? view.promptTemplate![Number(itemIndex)] : undefined) }
      catch (cause) { return error((cause as Error).message) }
    }
    // writeAccess asks on each write and records the first snapshot in this sitting.
    const original = target.active ? { ...target.preset, ...view } : target.preset
    if (!await this.writeAccess(tool, `edit prompt preset (${target.preset.name ?? target.index})`, { kind: 'preset', value: original, index: target.index })) return error('access denied by user')
    if (db.botPresets[target.index] !== target.preset || target.active !== (db.botPresetsId === target.index)) return error('preset selection changed during approval')
    if (tool === 'risu-set-prompt-preset-toggles') {
      target.preset.customPromptTemplateToggle = args.text as string
      if (target.active) db.customPromptTemplateToggle = args.text as string
    } else if (tool === 'risu-set-prompt-preset-field') {
      const field = args.field as 'mainPrompt' | 'jailbreak' | 'globalNote'
      target.preset[field] = args.text as string
      if (target.active) db[field] = args.text as string
    } else {
      const next = [...(view.promptTemplate ?? [])]
      if (tool === 'risu-set-prompt-preset-item') next[Number(itemIndex)] = nextItem!
      if (tool === 'risu-insert-prompt-preset-item') next.splice(Number(itemIndex), 0, nextItem!)
      if (tool === 'risu-delete-prompt-preset-item') next.splice(Number(itemIndex), 1)
      target.preset.promptTemplate = next
      if (target.active) db.promptTemplate = next
    }
    return response({ updated: true, index: target.index })
  }
}
