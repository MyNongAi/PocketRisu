import { describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ value: { characters: [] as any[], characterOrder: [] as any[] } }))

vi.mock('src/ts/stores.svelte', () => ({ DBState: { get db() { return db.value } }, selIdState: { selId: 0 } }))
vi.mock('src/ts/characterArchive', () => ({ getArchivedStubs: () => [{ chaId: 'gone', name: 'Sleeping' }] }))
vi.mock('src/ts/util', () => ({ pickHashRand: () => 7 }))

const { FolderHandler, findFolderByRef, folderCharacters, folderLorebooks, listFolders } = await import('./folders')

const fox = { id: 'f1', name: 'Fox', color: '', data: ['b1', 'k1', 'gone'] }
const inner = { id: 'f2', name: 'Inner', color: '', data: ['b2'], nodeOnlyParentFolderId: 'f1' }
const bots = [
    { chaId: 'b1', name: 'Maah', desc: 'A fox girl. '.repeat(40), globalLore: [{ comment: 'World', key: 'world', content: 'x', alwaysActive: true }, { comment: '', key: 'k', content: 'y', alwaysActive: false }] },
    { chaId: 'k1', name: 'Maah [백업 10-28 21:05]', desc: 'old', globalLore: [], nodeOnlyEditBackupOf: 'b1', nodeOnlyEditBackupAt: Date.UTC(2026, 9, 28, 12, 5) },
    { chaId: 'b2', name: 'Inside', desc: '', globalLore: [] },
]

describe('the folder tools', () => {
    it('lists the folders, a nested one with its parent', () => {
        expect(listFolders([fox, 'loose', inner] as any)).toEqual([
            { id: 'f1', name: 'Fox', characters: 3 },
            { id: 'f2', name: 'Inner', characters: 1, parent: 'f1' },
        ])
        expect(findFolderByRef([fox, inner] as any, 'Inner')?.id).toBe('f2')
        expect(findFolderByRef([fox, inner] as any, 'f1')?.name).toBe('Fox')
        expect(findFolderByRef([fox] as any, 'nope')).toBeUndefined()
    })

    it('lists a folder\'s bots, pairing a backup with its original, and a deactivated one by name', () => {
        const list = folderCharacters(fox as any, bots as any, [{ chaId: 'gone', name: 'Sleeping' }])
        expect(list[0]).toMatchObject({ id: 'b1', name: 'Maah', lorebooks: 2, backups: ['k1'] })
        expect((list[0] as { description: string }).description.length).toBeLessThanOrEqual(301)
        expect(list[1]).toMatchObject({ id: 'k1', backupOf: 'b1', backupAt: '2026-10-28T12:05:00.000Z' })
        expect(list[2]).toEqual({ id: 'gone', name: 'Sleeping', deactivated: true })
    })

    it('lists every bot\'s lorebook names at once, without their contents', () => {
        const lore = folderLorebooks(fox as any, bots as any, 1)
        expect(lore).toEqual([
            { id: 'b1', name: 'Maah', total: 2, lorebooks: [{ name: 'World', keys: 'world', alwaysActive: true }] },
            { id: 'k1', name: 'Maah [백업 10-28 21:05]', backupOf: 'b1', total: 0, lorebooks: [] },
        ])
        expect(JSON.stringify(lore)).not.toContain('"content"')
    })

    it('answers through the handler, and says when a folder is missing', async () => {
        db.value = { characters: bots, characterOrder: [fox, inner] }
        const handler = new FolderHandler()
        expect(handler.getTools().map((t) => t.name)).toEqual(['risu-list-character-folders', 'risu-list-folder-characters', 'risu-list-folder-lorebooks'])
        const textOf = (result: unknown) => (result as { text: string }[])[0].text
        const folders = JSON.parse(textOf(await handler.handle('risu-list-character-folders', {})))
        expect(folders).toHaveLength(2)
        const inside = JSON.parse(textOf(await handler.handle('risu-list-folder-characters', { folder: 'Inner' })))
        expect(inside[0].name).toBe('Inside')
        expect(textOf(await handler.handle('risu-list-folder-lorebooks', { folder: 'missing' }))).toContain('not found')
        expect(await handler.handle('risu-set-character-info', {})).toBeNull()
    })
})
