import { describe, expect, it, vi } from 'vitest'
import { folderForChatCopy } from './chatBranchFolder'
import type { ChatFolder } from './storage/database.svelte'

describe('folderForChatCopy', () => {
    it('leaves the source and folders unchanged when the setting is off', () => {
        const owner = { chatFolders: [] as ChatFolder[] }
        const source = { name: 'Original', folderId: 'missing' }
        const makeId = vi.fn(() => 'new')

        expect(folderForChatCopy(owner, source, false, makeId)).toBe('missing')
        expect(source.folderId).toBe('missing')
        expect(owner.chatFolders).toEqual([])
        expect(makeId).not.toHaveBeenCalled()
    })

    it('creates a first folder for an ungrouped source and returns its id for the copy', () => {
        const existing = { id: 'old', name: 'Older', folded: true }
        const owner = { chatFolders: [existing] }
        const source: { name: string, folderId?: string } = { name: 'Original' }

        const copyFolderId = folderForChatCopy(owner, source, true, () => 'new')
        expect(copyFolderId).toBe('new')
        expect(source.folderId).toBe(copyFolderId)
        expect(owner.chatFolders).toEqual([
            { id: 'new', name: 'Branches of Original', folded: false },
            existing,
        ])
    })

    it('keeps an existing folder without creating another', () => {
        const owner = { chatFolders: [{ id: 'existing', folded: false }] }
        const source = { name: 'Original', folderId: 'existing' }
        const makeId = vi.fn(() => 'new')

        expect(folderForChatCopy(owner, source, true, makeId)).toBe('existing')
        expect(owner.chatFolders).toHaveLength(1)
        expect(makeId).not.toHaveBeenCalled()
    })

    it('replaces an orphan folder id with a new folder', () => {
        const owner = { chatFolders: [{ id: 'existing', folded: false }] }
        const source = { name: 'Original', folderId: 'deleted' }

        expect(folderForChatCopy(owner, source, true, () => 'new')).toBe('new')
        expect(source.folderId).toBe('new')
        expect(owner.chatFolders[0]).toEqual({ id: 'new', name: 'Branches of Original', folded: false })
    })

    it('initializes chatFolders when it is undefined', () => {
        const owner: { chatFolders?: ChatFolder[] } = {}
        const source: { name: string, folderId?: string } = { name: 'Original' }

        expect(folderForChatCopy(owner, source, true, () => 'new')).toBe('new')
        expect(source.folderId).toBe('new')
        expect(owner.chatFolders).toEqual([{ id: 'new', name: 'Branches of Original', folded: false }])
    })
})
