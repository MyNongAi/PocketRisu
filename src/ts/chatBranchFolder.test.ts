import { describe, expect, it, vi } from 'vitest'
import { copyFolderPersonaName, folderForChatCopy } from './chatBranchFolder'
import type { ChatFolder } from './storage/database.svelte'

describe('copyFolderPersonaName', () => {
    it('uses the persona bound to the copied chat and trims its name', () => {
        const db = {
            personas: [
                { id: 'other', name: 'Other', icon: '', personaPrompt: '' },
                { id: 'bound', name: ' 망생 ', icon: '', personaPrompt: '' },
            ],
            username: 'Default',
        }
        const source = { id: 'original', name: 'Last input', bindedPersona: 'bound' }
        const owner = { chatFolders: [] as ChatFolder[] }

        expect(folderForChatCopy(owner, source, 7, true, () => 'point-7', copyFolderPersonaName(db, source))).toBe('point-7')
        expect(owner.chatFolders[0].name).toBe('Branches of 망생 (7)')
        expect(source.name).toBe('Last input')
    })

    it('falls back to the trimmed username without a binding', () => {
        expect(copyFolderPersonaName({ personas: [], username: ' Default ' }, {})).toBe('Default')
    })

    it('falls back to the username when the bound persona name is blank', () => {
        const db = { personas: [{ id: 'blank', name: '  ', icon: '', personaPrompt: '' }], username: ' Default ' }
        expect(copyFolderPersonaName(db, { bindedPersona: 'blank' })).toBe('Default')
    })

    it('falls back to User when the username is blank', () => {
        expect(copyFolderPersonaName({ personas: [], username: '  ' }, {})).toBe('User')
    })

    it('uses a name-only binding', () => {
        const db = { personas: [], nodeOnlyPersonaNames: { named: ' 이름만 ' }, username: 'Default' }
        expect(copyFolderPersonaName(db, { bindedPersona: 'named' })).toBe('이름만')
    })
})

describe('folderForChatCopy', () => {
    it('leaves the source and folders unchanged when the setting is off', () => {
        const owner = { chatFolders: [] as ChatFolder[] }
        const source = { id: 'original', name: 'Original', folderId: 'missing' }
        const makeId = vi.fn(() => 'new')

        expect(folderForChatCopy(owner, source, 5, false, makeId, 'User')).toBe('missing')
        expect(source.folderId).toBe('missing')
        expect(owner.chatFolders).toEqual([])
        expect(makeId).not.toHaveBeenCalled()
    })

    it('puts a loose source and its first copy in a new point folder at the front', () => {
        const existing: ChatFolder = { id: 'old', name: 'Older', folded: true }
        const owner = { chatFolders: [existing] }
        const source: { id: string, name: string, folderId?: string } = { id: 'original', name: 'Original' }

        expect(folderForChatCopy(owner, source, 5, true, () => 'point-5', 'User')).toBe('point-5')
        expect(source.folderId).toBe('point-5')
        expect(owner.chatFolders).toEqual([
            { id: 'point-5', name: 'Branches of User (5)', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 5 } },
            existing,
        ])
    })

    it('reuses the source folder for another copy at the same point', () => {
        const owner = { chatFolders: [{ id: 'point-5', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 5 } }] }
        const source = { id: 'original', name: 'Original', folderId: 'point-5' }
        const makeId = vi.fn(() => 'new')

        expect(folderForChatCopy(owner, source, 5, true, makeId, 'User')).toBe('point-5')
        expect(owner.chatFolders).toHaveLength(1)
        expect(makeId).not.toHaveBeenCalled()
    })

    it('puts a copy of a copy at the same point in its source folder', () => {
        const owner = { chatFolders: [{ id: 'point-5', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 5 } }] }
        const copy = { id: 'copy', name: 'Copy', folderId: 'point-5' }
        const makeId = vi.fn(() => 'new')

        expect(folderForChatCopy(owner, copy, 5, true, makeId, 'User')).toBe('point-5')
        expect(copy.folderId).toBe('point-5')
        expect(owner.chatFolders).toHaveLength(1)
        expect(makeId).not.toHaveBeenCalled()
    })

    it('moves a grown original into its new point folder with the copy, then reuses it', () => {
        const point5: ChatFolder = { id: 'point-5', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 5 } }
        const owner = { chatFolders: [point5] }
        const source = { id: 'original', name: 'Original', folderId: 'point-5' }
        const makeId = vi.fn(() => 'point-6')

        expect(folderForChatCopy(owner, source, 6, true, makeId, 'User')).toBe('point-6')
        // The copied chat and its copy share the folder; the copies at 5 stay at 5.
        expect(source.folderId).toBe('point-6')
        expect(owner.chatFolders).toEqual([
            { id: 'point-6', name: 'Branches of User (6)', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 6 }, nodeOnlyParentFolderId: 'point-5' },
            point5,
        ])
        expect(folderForChatCopy(owner, source, 6, true, makeId, 'User')).toBe('point-6')
        expect(owner.chatFolders).toHaveLength(2)
        expect(makeId).toHaveBeenCalledTimes(1)
    })

    it('numbers a folder whose name is taken, as copies are', () => {
        const point5: ChatFolder = { id: 'point-5', name: 'Branches of 망생 (5)', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 5 } }
        const taken: ChatFolder = { id: 'other-6', name: 'Branches of 망생 (6)', folded: false, nodeOnlyCopyPoint: { chatId: 'other', messages: 6 } }
        const owner = { chatFolders: [point5, taken] }
        const source = { id: 'original', name: 'Original', folderId: 'point-5' }
        const ids = ['point-6', 'point-7']

        expect(folderForChatCopy(owner, source, 6, true, () => ids.shift()!, '망생')).toBe('point-6')
        expect(folderForChatCopy(owner, source, 7, true, () => ids.shift()!, '망생')).toBe('point-7')
        expect(owner.chatFolders.map(folder => folder.name)).toEqual([
            'Branches of 망생 (7)',
            'Branches of 망생 (6) (2)',
            'Branches of 망생 (5)',
            'Branches of 망생 (6)',
        ])
        expect(owner.chatFolders[0].nodeOnlyParentFolderId).toBe('point-6')
        expect(owner.chatFolders[1].nodeOnlyParentFolderId).toBe('point-5')
    })

    it('gives a grown copy its own next point folder and moves it in', () => {
        const owner: { chatFolders: ChatFolder[] } = { chatFolders: [
            { id: 'point-5', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 5 } },
            { id: 'original-6', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 6 } },
        ] }
        const copy = { id: 'copy', name: 'Copy', folderId: 'point-5' }

        expect(folderForChatCopy(owner, copy, 6, true, () => 'copy-6', 'User')).toBe('copy-6')
        expect(copy.folderId).toBe('copy-6')
        expect(owner.chatFolders[0].nodeOnlyCopyPoint).toEqual({ chatId: 'copy', messages: 6 })
        expect(owner.chatFolders[0].nodeOnlyParentFolderId).toBe('point-5')
        expect(owner.chatFolders).toHaveLength(3)
    })

    it('moves a loose chat back in when its point folder already exists', () => {
        const point6: ChatFolder = { id: 'point-6', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 6 } }
        const owner = { chatFolders: [point6] }
        const source: { id: string, name: string, folderId?: string } = { id: 'original', name: 'Original' }
        const makeId = vi.fn(() => 'new')

        expect(folderForChatCopy(owner, source, 6, true, makeId, 'User')).toBe('point-6')
        expect(source.folderId).toBe('point-6')
        expect(makeId).not.toHaveBeenCalled()
    })

    it('puts the copy of a chat in a user folder into that folder', () => {
        const userFolder: ChatFolder = { id: 'user', name: 'My chats', folded: false }
        const owner = { chatFolders: [userFolder] }
        const source = { id: 'original', name: 'Original', folderId: 'user' }
        const makeId = vi.fn(() => 'new')

        expect(folderForChatCopy(owner, source, 5, true, makeId, 'User')).toBe('user')
        expect(source.folderId).toBe('user')
        expect(owner.chatFolders).toEqual([userFolder])
        expect(makeId).not.toHaveBeenCalled()
    })

    it('puts the copy of a chat in a folder from before points into that folder', () => {
        const oldFolder: ChatFolder = { id: 'old', name: 'Branches of Original', folded: false }
        const owner = { chatFolders: [oldFolder] }
        const source = { id: 'original', name: 'Original', folderId: 'old' }

        expect(folderForChatCopy(owner, source, 9, true, () => 'new', 'User')).toBe('old')
        expect(source.folderId).toBe('old')
        expect(owner.chatFolders).toEqual([oldFolder])
    })

    it('treats a missing folder id as loose', () => {
        const owner = { chatFolders: [{ id: 'other', folded: false }] as ChatFolder[] }
        const source = { id: 'original', name: 'Original', folderId: 'deleted' }

        expect(folderForChatCopy(owner, source, 5, true, () => 'point-5', 'User')).toBe('point-5')
        expect(source.folderId).toBe('point-5')
        expect(owner.chatFolders[0].nodeOnlyCopyPoint).toEqual({ chatId: 'original', messages: 5 })
    })

    it('initializes chatFolders when it is undefined', () => {
        const owner: { chatFolders?: ChatFolder[] } = {}
        const source: { id: string, name: string, folderId?: string } = { id: 'original', name: 'Original' }

        expect(folderForChatCopy(owner, source, 5, true, () => 'point-5', 'User')).toBe('point-5')
        expect(source.folderId).toBe('point-5')
        expect(owner.chatFolders).toEqual([
            { id: 'point-5', name: 'Branches of User (5)', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 5 } },
        ])
    })
})
