import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ value: { characters: [] as any[], characterOrder: [] as any[] } }))
const removeChar = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('src/lang', () => ({ language: { editModeBackupName: '{name} [백업 {time}]' } }))
vi.mock('src/ts/characters', () => ({ removeChar }))
vi.mock('src/ts/globalApi.svelte', () => ({ checkCharOrder: vi.fn() }))
vi.mock('src/ts/storage/database.svelte', () => ({ newChatModelDefaults: () => ({}) }))
vi.mock('src/ts/stores.svelte', () => ({ DBState: { get db() { return db.value } } }))

const { backupCharacterCopy, backupsOf, placeBackup, KEPT_BACKUPS } = await import('./editBackup')

beforeEach(() => {
    removeChar.mockClear()
})

describe('a bot backup', () => {
    it('goes into the original\'s folder, or right after it at the top', () => {
        const folder = { id: 'f1', name: 'Fox', color: '', data: ['b1', 'b2'] }
        expect(placeBackup([folder, 'b3'], 'b1', 'k1')).toEqual([{ ...folder, data: ['b1', 'b2', 'k1'] }, 'b3'])
        expect(placeBackup(['b3', 'b1', 'b4'], 'b1', 'k1')).toEqual(['b3', 'b1', 'k1', 'b4'])
    })

    it('copies the bot without its chats, named with the time, and keeps the newest few', async () => {
        const original: any = { chaId: 'b1', name: 'Maah', desc: 'Fox', globalLore: [{ content: 'one' }], chats: [{ message: ['long chat'] }] }
        const old = Array.from({ length: KEPT_BACKUPS }, (_, i) => ({ chaId: `old${i}`, name: 'old', nodeOnlyEditBackupOf: 'b1', nodeOnlyEditBackupAt: i + 1 }))
        db.value = { characters: [original, ...old], characterOrder: [{ id: 'f1', name: 'Fox', data: ['b1', 'old0', 'old1', 'old2'] }] }

        const at = new Date(2026, 9, 28, 21, 5).getTime()
        const id = backupCharacterCopy(original, at)
        const backup = db.value.characters.find((c) => c.chaId === id)
        expect(backup.name).toBe('Maah [백업 10-28 21:05]')
        expect(backup).toMatchObject({ desc: 'Fox', globalLore: [{ content: 'one' }], nodeOnlyEditBackupOf: 'b1', nodeOnlyEditBackupAt: at, nodeOnlyEditBackupName: 'Maah' })
        expect(backup.chats).toHaveLength(1)
        expect(backup.chats[0].message).toEqual([])
        expect(db.value.characterOrder[0].data).toContain(id)
        original.globalLore[0].content = 'edited'
        expect(backup.globalLore[0].content).toBe('one')

        await Promise.resolve()
        expect(backupsOf(db.value.characters, 'b1')[0].chaId).toBe(id)
        expect(removeChar).toHaveBeenCalledTimes(1)
        expect(removeChar).toHaveBeenCalledWith('old0', 'old', 'normal', { skipConfirm: true })
    })
})
