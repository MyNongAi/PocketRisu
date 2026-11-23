import { describe, expect, it, vi } from 'vitest'
import { folderForChatCopy } from './chatBranchFolder'
import type { ChatFolder } from './storage/database.svelte'

describe('folderForChatCopy', () => {
    it('leaves the source and folders unchanged when the setting is off', () => {
        const owner = { chatFolders: [] as ChatFolder[] }
        const source = { id: 'original', name: 'Original', folderId: 'missing' }
        const makeId = vi.fn(() => 'new')

        expect(folderForChatCopy(owner, source, 5, false, makeId)).toBe('missing')
        expect(source.folderId).toBe('missing')
        expect(owner.chatFolders).toEqual([])
        expect(makeId).not.toHaveBeenCalled()
    })

    it('puts a loose source and its first copy in a new point folder at the front', () => {
        const existing: ChatFolder = { id: 'old', name: 'Older', folded: true }
        const owner = { chatFolders: [existing] }
        const source: { id: string, name: string, folderId?: string } = { id: 'original', name: 'Original' }

        expect(folderForChatCopy(owner, source, 5, true, () => 'point-5')).toBe('point-5')
        expect(source.folderId).toBe('point-5')
        expect(owner.chatFolders).toEqual([
            { id: 'point-5', name: 'Branches of Original', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 5 } },
            existing,
        ])
    })

    it('reuses the source folder for another copy at the same point', () => {
        const owner = { chatFolders: [{ id: 'point-5', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 5 } }] }
        const source = { id: 'original', name: 'Original', folderId: 'point-5' }
        const makeId = vi.fn(() => 'new')

        expect(folderForChatCopy(owner, source, 5, true, makeId)).toBe('point-5')
        expect(owner.chatFolders).toHaveLength(1)
        expect(makeId).not.toHaveBeenCalled()
    })

    it('puts a copy of a copy at the same point in its source folder', () => {
        const owner = { chatFolders: [{ id: 'point-5', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 5 } }] }
        const copy = { id: 'copy', name: 'Copy', folderId: 'point-5' }
        const makeId = vi.fn(() => 'new')

        expect(folderForChatCopy(owner, copy, 5, true, makeId)).toBe('point-5')
        expect(copy.folderId).toBe('point-5')
        expect(owner.chatFolders).toHaveLength(1)
        expect(makeId).not.toHaveBeenCalled()
    })

    it('moves a grown original into its new point folder with the copy, then reuses it', () => {
        const point5: ChatFolder = { id: 'point-5', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 5 } }
        const owner = { chatFolders: [point5] }
        const source = { id: 'original', name: 'Original', folderId: 'point-5' }
        const makeId = vi.fn(() => 'point-6')

        expect(folderForChatCopy(owner, source, 6, true, makeId)).toBe('point-6')
        // The copied chat and its copy share the folder; the copies at 5 stay at 5.
        expect(source.folderId).toBe('point-6')
        expect(owner.chatFolders).toEqual([
            { id: 'point-6', name: 'Branches of Original', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 6 } },
            point5,
        ])
        expect(folderForChatCopy(owner, source, 6, true, makeId)).toBe('point-6')
        expect(owner.chatFolders).toHaveLength(2)
        expect(makeId).toHaveBeenCalledTimes(1)
    })

    it('numbers a folder whose name is taken, as copies are', () => {
        const point5: ChatFolder = { id: 'point-5', name: 'Branches of Original', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 5 } }
        const owner = { chatFolders: [point5] }
        const source = { id: 'original', name: 'Original', folderId: 'point-5' }
        const ids = ['point-6', 'point-7']

        expect(folderForChatCopy(owner, source, 6, true, () => ids.shift()!)).toBe('point-6')
        expect(folderForChatCopy(owner, source, 7, true, () => ids.shift()!)).toBe('point-7')
        expect(owner.chatFolders.map(folder => folder.name)).toEqual([
            'Branches of Original (3)',
            'Branches of Original (2)',
            'Branches of Original',
        ])
    })

    it('gives a grown copy its own next point folder and moves it in', () => {
        const owner: { chatFolders: ChatFolder[] } = { chatFolders: [
            { id: 'point-5', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 5 } },
            { id: 'original-6', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 6 } },
        ] }
        const copy = { id: 'copy', name: 'Copy', folderId: 'point-5' }

        expect(folderForChatCopy(owner, copy, 6, true, () => 'copy-6')).toBe('copy-6')
        expect(copy.folderId).toBe('copy-6')
        expect(owner.chatFolders[0].nodeOnlyCopyPoint).toEqual({ chatId: 'copy', messages: 6 })
        expect(owner.chatFolders).toHaveLength(3)
    })

    it('moves a loose chat back in when its point folder already exists', () => {
        const point6: ChatFolder = { id: 'point-6', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 6 } }
        const owner = { chatFolders: [point6] }
        const source: { id: string, name: string, folderId?: string } = { id: 'original', name: 'Original' }
        const makeId = vi.fn(() => 'new')

        expect(folderForChatCopy(owner, source, 6, true, makeId)).toBe('point-6')
        expect(source.folderId).toBe('point-6')
        expect(makeId).not.toHaveBeenCalled()
    })

    it('puts the copy of a chat in a user folder into that folder', () => {
        const userFolder: ChatFolder = { id: 'user', name: 'My chats', folded: false }
        const owner = { chatFolders: [userFolder] }
        const source = { id: 'original', name: 'Original', folderId: 'user' }
        const makeId = vi.fn(() => 'new')

        expect(folderForChatCopy(owner, source, 5, true, makeId)).toBe('user')
        expect(source.folderId).toBe('user')
        expect(owner.chatFolders).toEqual([userFolder])
        expect(makeId).not.toHaveBeenCalled()
    })

    it('puts the copy of a chat in a folder from before points into that folder', () => {
        const oldFolder: ChatFolder = { id: 'old', name: 'Branches of Original', folded: false }
        const owner = { chatFolders: [oldFolder] }
        const source = { id: 'original', name: 'Original', folderId: 'old' }

        expect(folderForChatCopy(owner, source, 9, true, () => 'new')).toBe('old')
        expect(source.folderId).toBe('old')
        expect(owner.chatFolders).toEqual([oldFolder])
    })

    it('treats a missing folder id as loose', () => {
        const owner = { chatFolders: [{ id: 'other', folded: false }] as ChatFolder[] }
        const source = { id: 'original', name: 'Original', folderId: 'deleted' }

        expect(folderForChatCopy(owner, source, 5, true, () => 'point-5')).toBe('point-5')
        expect(source.folderId).toBe('point-5')
        expect(owner.chatFolders[0].nodeOnlyCopyPoint).toEqual({ chatId: 'original', messages: 5 })
    })

    it('initializes chatFolders when it is undefined', () => {
        const owner: { chatFolders?: ChatFolder[] } = {}
        const source: { id: string, name: string, folderId?: string } = { id: 'original', name: 'Original' }

        expect(folderForChatCopy(owner, source, 5, true, () => 'point-5')).toBe('point-5')
        expect(source.folderId).toBe('point-5')
        expect(owner.chatFolders).toEqual([
            { id: 'point-5', name: 'Branches of Original', folded: false, nodeOnlyCopyPoint: { chatId: 'original', messages: 5 } },
        ])
    })
})
