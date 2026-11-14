import { MCPClientLike } from '../internalmcp'
import type { MCPTool, MCPToolHandler, RPCToolCallContent } from '../mcplib'
import { CharacterHandler } from './characters'
import { ChatHandler } from './chats'
import { ModuleHandler } from './modules'
import { FolderHandler } from './folders'
import { PresetHandler } from './presets'
import { editKinds, risuAccessInstructions, type EditKind } from './editKinds'
import type { WriteAccess } from './writeAccess'

export class RisuAccessClient extends MCPClientLike {
  private handlers: { kind: EditKind, handler: MCPToolHandler }[]
  private readonly external: boolean

  /** External clients can only receive bot and module tools. */
  constructor(options: { writeAccess?: WriteAccess, external?: boolean } = {}) {
    super('internal:risuai')
    this.serverInfo.serverInfo.name = 'Risuai Access MCP'
    this.serverInfo.serverInfo.version = '1.0.0'
    this.handlers = [
      { kind: 'bot', handler: new CharacterHandler(options.writeAccess) },
      { kind: 'bot', handler: new ChatHandler() },
      { kind: 'module', handler: new ModuleHandler(options.writeAccess) },
      { kind: 'bot', handler: new FolderHandler() },
    ]
    if (!options.external) this.handlers.push({ kind: 'preset', handler: new PresetHandler(options.writeAccess) })
    this.external = options.external === true
    this.refreshInstructions()
  }

  private refreshInstructions(): void {
    const kinds = editKinds()
    this.serverInfo.instructions = risuAccessInstructions(this.external ? { ...kinds, preset: false } : kinds)
  }

  async getToolList(): Promise<MCPTool[]> {
    this.refreshInstructions()
    const kinds = editKinds()
    return this.handlers.flatMap(({ kind, handler }) => kinds[kind] ? handler.getTools() : [])
  }

  async callTool(toolName: string, args: any): Promise<RPCToolCallContent[]> {
    try {
      for (const { kind, handler } of this.handlers) {
        if (!handler.getTools().some((tool) => tool.name === toolName)) continue
        if (!editKinds()[kind]) {
          const label = { bot: '봇', module: '모듈', preset: '프리셋' }[kind]
          return [{ type: 'text', text: `Turn on the ${label} switch under 고칠 것 to use this tool.` }]
        }
        return await handler.handle(toolName, args) ?? [{ type: 'text', text: `Tool ${toolName} not found.` }]
      }
    } catch (error) {
      return [{ type: 'text', text: `Error: ${(error as Error).message}` }]
    }
    return [{ type: 'text', text: `Tool ${toolName} not found.` }]
  }
}
