import { describe, expect, it } from 'vitest'
import { backupModule, editBackupCount, restoreCharacterFrom, restoreEdits, type EditSession } from './editSession'

function session(): EditSession {
    return { approval: 'auto', startedAt: 1 }
}

describe('putting edits back', () => {
    it('puts a bot back from its backup bot, with the name the backup kept aside', () => {
        const bot: any = { chaId: 'b1', name: 'Changed', desc: 'Wolf', backgroundHTML: '<div>new</div>', globalLore: [{ content: 'two' }], chats: [{ message: ['kept'] }] }
        const backup: any = { chaId: 'k1', name: 'Maah [백업 10-28 21:30]', desc: 'Fox', globalLore: [{ content: 'one' }], nodeOnlyEditBackupOf: 'b1', nodeOnlyEditBackupName: 'Maah' }
        restoreCharacterFrom(bot, backup)
        expect(bot.name).toBe('Maah')
        expect(bot.desc).toBe('Fox')
        expect(bot.globalLore).toEqual([{ content: 'one' }])
        expect('backgroundHTML' in bot).toBe(false)
        expect(bot.chats).toEqual([{ message: ['kept'] }])
        backup.globalLore[0].content = 'edited later'
        expect(bot.globalLore).toEqual([{ content: 'one' }])
    })

    it('copies a module once and puts it back, on or off as it was', () => {
        const module: any = { id: 'm1', name: 'Assets', lorebook: [{ content: 'rule' }], regex: [] }
        const db: any = { characters: [], modules: [module], enabledModules: [] as string[] }
        const s = session()
        backupModule(s, module, db.enabledModules)
        module.lorebook = []
        module.regex.push({ in: 'x' })
        backupModule(s, module, db.enabledModules)
        db.enabledModules = ['m1']

        expect(editBackupCount(s)).toEqual({ characters: 0, modules: 1 })
        expect(restoreEdits(s, db)).toEqual({ characters: 0, modules: 1 })
        expect(module.lorebook).toEqual([{ content: 'rule' }])
        expect(module.regex).toEqual([])
        expect(db.enabledModules).toEqual([])
        expect(editBackupCount(s)).toEqual({ characters: 0, modules: 0 })
    })

    it('puts every bot of the sitting back from its backup, skipping what is gone', () => {
        const bot: any = { chaId: 'b1', name: 'X', desc: 'new' }
        const backup: any = { chaId: 'k1', name: 'X [백업]', desc: 'old', nodeOnlyEditBackupName: 'X' }
        const s: EditSession = { ...session(), characters: { b1: 'k1', gone: 'k9' } }
        expect(restoreEdits(s, { characters: [bot, backup], modules: [] })).toEqual({ characters: 1, modules: 0 })
        expect(bot.desc).toBe('old')
        expect(s.characters).toEqual({})
    })
})
