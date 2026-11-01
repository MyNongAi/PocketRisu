import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ value: { characters: [] as any[], modules: [] as any[], enabledModules: [] as string[] } }))
const alertSelect = vi.hoisted(() => vi.fn())
const notifyInfo = vi.hoisted(() => vi.fn())
const changeChatTo = vi.hoisted(() => vi.fn())
const elsewhere = vi.hoisted(() => ({ value: [] as string[] }))

vi.mock('src/lang', () => ({ language: new Proxy({}, { get: (_t, key) => String(key) }) }))
vi.mock('src/ts/alert', () => ({ alertSelect, notifyInfo, alertConfirm: vi.fn(async () => true), notifyError: vi.fn(), notifySuccess: vi.fn() }))
vi.mock('src/ts/globalApi.svelte', () => ({ changeChatTo, requestImmediateSave: vi.fn(async () => {}) }))
vi.mock('src/ts/storage/database.svelte', () => ({ newChatModelDefaults: () => ({ useModelPreset: true }) }))
vi.mock('src/ts/stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return { DBState: { get db() { return db.value } }, ReloadGUIPointer: writable(0), selIdState: { selId: 0 } }
})
// What is on for a chat: its own modules, and what `elsewhere` turns on (the bot's, everywhere).
vi.mock('../modules', () => ({
    addModuleToDatabase: (module: any) => { db.value.modules.push(module) },
    captureModuleRuntimeContext: (_char: any, chat: any) => ({ chat }),
    getModuleMcps: (ctx: any) => db.value.modules
        .filter((m) => (ctx.chat.modules ?? []).includes(m.id) || elsewhere.value.includes(m.id))
        .map((m) => m.mcp?.url),
}))
vi.mock('./mcp', () => ({
    getMCPMeta: async () => ({ 'internal:risuai': { serverInfo: { name: 'Risuai Access MCP', version: '1' }, instructions: '' } }),
    mcpModuleOf: (url: string) => ({ id: 'mcp-new', name: 'Risuai Access MCP', mcp: { url }, lorebook: [] }),
}))
vi.mock('./toolGate', () => ({ RISU_ACCESS_URL: 'internal:risuai' }))

const { chooseEditMode, editModeChoice, editModeOn, externalEditRefusal, setEditApproval, startEditMode, stopEditMode } = await import('./editMode')

function bot() {
    const chat: any = { id: 'c1', name: 'Chat 1', message: [], modules: ['other'] }
    const char: any = { chaId: 'b1', name: 'Maah', desc: 'Fox', chats: [chat], chatPage: 0 }
    db.value = { characters: [char], modules: [], enabledModules: [] }
    return { char, chat }
}

beforeEach(() => {
    alertSelect.mockReset()
    notifyInfo.mockReset()
    changeChatTo.mockReset()
    elsewhere.value = []
})

describe('the bot edit mode follows the Risu Access module', () => {
    it('is on exactly while the module is on for the chat', () => {
        const { char, chat } = bot()
        db.value.modules.push({ id: 'ra', mcp: { url: 'internal:risuai' } })
        expect(editModeOn(char, chat)).toBe(false)
        chat.modules.push('ra')
        expect(editModeOn(char, chat)).toBe(true)
    })

    it('in this chat: adds the module when there is none, turns it on, and off again', async () => {
        const { char, chat } = bot()
        alertSelect.mockResolvedValueOnce('1')
        expect(await startEditMode(char, chat)).toBe(true)
        expect(notifyInfo).toHaveBeenCalledWith('editModeModuleAdded')
        expect(chat.modules).toEqual(['other', 'mcp-new'])
        expect(editModeOn(char, chat)).toBe(true)
        expect(chat.nodeOnlyEditSession).toMatchObject({ approval: 'ask' })

        expect(await stopEditMode(char, chat)).toBe(true)
        expect(chat.modules).toEqual(['other'])
        expect(editModeOn(char, chat)).toBe(false)
        expect(alertSelect).toHaveBeenCalledTimes(1)
    })

    it('in a new edit chat: opens it at the top with the module, keeping the approval', async () => {
        const { char, chat } = bot()
        db.value.modules.push({ id: 'ra', mcp: { url: 'internal:risuai' } })
        setEditApproval(chat, 'auto')
        alertSelect.mockResolvedValueOnce('0')
        await startEditMode(char, chat)
        const edit = char.chats[0]
        expect(edit.name).toBe('editModeChatName')
        expect(changeChatTo).toHaveBeenCalledWith(0)
        expect(edit.modules).toEqual(['ra'])
        expect(edit.nodeOnlyEditSession.approval).toBe('auto')
        expect(chat.modules).toEqual(['other'])
        expect(notifyInfo).not.toHaveBeenCalled()
    })

    it('says so when the module stays on from elsewhere', async () => {
        const { char, chat } = bot()
        db.value.modules.push({ id: 'ra', mcp: { url: 'internal:risuai' } })
        elsewhere.value = ['ra']
        expect(await stopEditMode(char, chat)).toBe(true)
        expect(notifyInfo).toHaveBeenCalledWith('editModeStillOn')
    })

    it('asks keep or undo when the AI changed something, and undoes on request', async () => {
        const { char, chat } = bot()
        const backup = { chaId: 'k1', name: 'Maah [백업]', desc: 'Fox', nodeOnlyEditBackupName: 'Maah' }
        db.value.characters.push(backup)
        db.value.modules.push({ id: 'ra', mcp: { url: 'internal:risuai' } })
        chat.modules.push('ra')
        chat.nodeOnlyEditSession = { approval: 'auto', startedAt: 1, characters: { b1: 'k1' } }
        char.desc = 'Wolf'

        alertSelect.mockResolvedValueOnce('2')
        expect(await stopEditMode(char, chat)).toBe(false)
        expect(chat.modules).toContain('ra')

        alertSelect.mockResolvedValueOnce('1')
        expect(await stopEditMode(char, chat)).toBe(true)
        expect(char.desc).toBe('Fox')
        expect(chat.modules).toEqual(['other'])
        expect(chat.nodeOnlyEditSession).toMatchObject({ approval: 'auto' })
        expect(chat.nodeOnlyEditSession.characters).toBeUndefined()
    })

    it('does nothing when the question is cancelled', async () => {
        const { char, chat } = bot()
        alertSelect.mockResolvedValueOnce('2')
        expect(await startEditMode(char, chat)).toBe(false)
        expect(db.value.modules).toHaveLength(0)
        expect(chat.modules).toEqual(['other'])
    })
})

describe('the dropdown picks one: off, built-in, or an app outside', () => {
    it('is off by default, and the apps outside are refused then', () => {
        const { char, chat } = bot()
        expect(editModeChoice(char, chat)).toBe('off')
        expect(externalEditRefusal()).toBe('externalMcpEditModeOff')
    })

    it('an app turns the server on, then lets that app edit; off refuses again', async () => {
        const { char, chat } = bot()
        const enable = vi.fn(async () => true)
        expect(await chooseEditMode(char, chat, 'codex', enable)).toBe(true)
        expect(enable).toHaveBeenCalledOnce()
        expect(editModeChoice(char, chat)).toBe('codex')
        expect(externalEditRefusal()).toBeNull()

        expect(await chooseEditMode(char, chat, 'off', enable)).toBe(true)
        expect(enable).toHaveBeenCalledOnce()
        expect(editModeChoice(char, chat)).toBe('off')
        expect(externalEditRefusal()).toBe('externalMcpEditModeOff')
    })

    it('built-in ends the apps’ turn, and an app ends this chat’s built-in mode', async () => {
        const { char, chat } = bot()
        const enable = vi.fn(async () => true)
        await chooseEditMode(char, chat, 'antigravity', enable)

        alertSelect.mockResolvedValueOnce('1')
        expect(await chooseEditMode(char, chat, 'builtin', enable)).toBe(true)
        expect(editModeChoice(char, chat)).toBe('builtin')
        expect(externalEditRefusal()).toBe('externalMcpEditModeOff')

        expect(await chooseEditMode(char, chat, 'claude-code', enable)).toBe(true)
        expect(editModeOn(char, chat)).toBe(false)
        expect(editModeChoice(char, chat)).toBe('claude-code')
    })

    it('changes nothing when the server cannot be turned on or a question is cancelled', async () => {
        const { char, chat } = bot()
        expect(await chooseEditMode(char, chat, 'codex', async () => false)).toBe(false)
        expect(editModeChoice(char, chat)).toBe('off')

        db.value.modules.push({ id: 'ra', mcp: { url: 'internal:risuai' } })
        chat.modules.push('ra')
        chat.nodeOnlyEditSession = { approval: 'ask', startedAt: 1, characters: { b1: 'k1' } }
        alertSelect.mockResolvedValueOnce('2')
        expect(await chooseEditMode(char, chat, 'codex', async () => true)).toBe(false)
        expect(editModeChoice(char, chat)).toBe('builtin')
        expect((db.value as any).nodeOnlyExternalEditApp).toBeUndefined()
    })
})
