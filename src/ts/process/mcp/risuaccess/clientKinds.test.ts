import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ value: { nodeOnlyEditModeKinds: undefined as any } }))
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => db.value }))
const mockHandler = vi.hoisted(() => (name: string) => class {
  getTools() { return [{ name, description: '', inputSchema: {} }] }
  async handle() { return [{ type: 'text' as const, text: 'ran' }] }
})
vi.mock('./characters', () => ({ CharacterHandler: mockHandler('risu-list-characters') }))
vi.mock('./chats', () => ({ ChatHandler: mockHandler('risu-get-chat-history') }))
vi.mock('./modules', () => ({ ModuleHandler: mockHandler('risu-list-modules') }))
vi.mock('./folders', () => ({ FolderHandler: mockHandler('risu-list-character-folders') }))
vi.mock('./presets', () => ({ PresetHandler: mockHandler('risu-list-prompt-presets') }))

const { RisuAccessClient } = await import('./client')

beforeEach(() => { db.value.nodeOnlyEditModeKinds = undefined })

describe('Risu Access kinds', () => {
  it('defaults to bot and module tools and guides', async () => {
    const client = new RisuAccessClient()
    expect((await client.getToolList()).map((tool) => tool.name)).toEqual([
      'risu-list-characters', 'risu-get-chat-history', 'risu-list-modules', 'risu-list-character-folders',
    ])
    expect(client.serverInfo.instructions).toContain('Characters are the AI personas')
    expect(client.serverInfo.instructions).toContain('Modules are independant packages')
    expect(client.serverInfo.instructions).not.toContain('Prompt presets contain')
  })

  it('updates tool list and guide, and refuses a tool whose switch is off', async () => {
    const client = new RisuAccessClient()
    db.value.nodeOnlyEditModeKinds = { bot: false, module: false, preset: true }
    expect((await client.getToolList()).map((tool) => tool.name)).toEqual(['risu-list-prompt-presets'])
    expect(client.serverInfo.instructions).toContain('Prompt presets contain')
    expect(client.serverInfo.instructions).not.toContain('Characters are the AI personas')
    expect(((await client.callTool('risu-list-characters', {}))[0] as { text: string }).text).toContain('봇')
  })

  it('never registers preset tools or guide on an external client', async () => {
    db.value.nodeOnlyEditModeKinds = { bot: true, module: false, preset: true }
    const client = new RisuAccessClient({ external: true })
    expect((await client.getToolList()).map((tool) => tool.name)).toEqual([
      'risu-list-characters', 'risu-get-chat-history', 'risu-list-character-folders',
    ])
    expect(client.serverInfo.instructions).not.toContain('Prompt presets contain')
    expect(((await client.callTool('risu-list-prompt-presets', {}))[0] as { text: string }).text).toContain('not found')
  })
})
