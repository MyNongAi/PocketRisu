import { beforeEach, describe, expect, it, vi } from 'vitest'

const chat = vi.hoisted(() => ({ value: null as any }))
const alertConfirm = vi.hoisted(() => vi.fn())
const backupCharacterCopy = vi.hoisted(() => vi.fn((char: any) => `backup-of-${char.chaId}`))

vi.mock('src/lang', () => ({ language: { mcpAccessPrompt: 'Allow {{tool}}: {{action}}?' } }))
vi.mock('src/ts/alert', () => ({ alertConfirm }))
vi.mock('src/ts/storage/database.svelte', () => ({ getCurrentChat: () => chat.value }))
vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: { enabledModules: [] } } }))
vi.mock('../editBackup', () => ({ backupCharacterCopy }))

const { mcpWriteAccess } = await import('./writeAccess')

beforeEach(() => {
    chat.value = { id: 'c' }
    alertConfirm.mockReset()
    backupCharacterCopy.mockClear()
})

describe('a Risu Access write', () => {
    it('asks by default, and backs the bot up once when allowed', async () => {
        alertConfirm.mockResolvedValue(true)
        const bot: any = { chaId: 'b1', name: 'Maah' }
        expect(await mcpWriteAccess('risu-set-character-info', 'modify', { kind: 'character', value: bot })).toBe(true)
        expect(await mcpWriteAccess('risu-set-character-lorebook', 'modify', { kind: 'character', value: bot })).toBe(true)
        expect(alertConfirm).toHaveBeenCalledWith('Allow risu-set-character-info: modify?')
        expect(backupCharacterCopy).toHaveBeenCalledTimes(1)
        expect(chat.value.nodeOnlyEditSession).toMatchObject({ approval: 'ask', characters: { b1: 'backup-of-b1' } })
    })

    it('writes without asking in auto', async () => {
        chat.value.nodeOnlyEditSession = { approval: 'auto', startedAt: 1 }
        expect(await mcpWriteAccess('t', 'a', { kind: 'character', value: { chaId: 'b1' } as any })).toBe(true)
        expect(alertConfirm).not.toHaveBeenCalled()
        expect(chat.value.nodeOnlyEditSession.characters).toEqual({ b1: 'backup-of-b1' })
    })

    it('backs nothing up when refused, and never backs up a backup bot', async () => {
        alertConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
        expect(await mcpWriteAccess('t', 'a', { kind: 'module', value: { id: 'm1' } })).toBe(false)
        expect(chat.value.nodeOnlyEditSession).toBeUndefined()
        expect(await mcpWriteAccess('t', 'a', { kind: 'character', value: { chaId: 'k1', nodeOnlyEditBackupOf: 'b1' } as any })).toBe(true)
        expect(backupCharacterCopy).not.toHaveBeenCalled()
    })

    it('records a module in the sitting', async () => {
        chat.value.nodeOnlyEditSession = { approval: 'auto', startedAt: 1 }
        await mcpWriteAccess('t', 'a', { kind: 'module', value: { id: 'm1', name: 'Assets' } as any })
        expect(chat.value.nodeOnlyEditSession.modules.m1).toMatchObject({ name: 'Assets', enabled: false })
    })
})
