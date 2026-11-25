import { describe, expect, it } from 'vitest'
import { removeChatFolder, type EditableChat, type EditableChatFolder } from './chatFolderEdit'

const folder = (id?: string): EditableChatFolder => ({ id })
const chat = (folderId?: string | null): EditableChat => ({ folderId })

describe('CHAT-FOLDER-DELETE-BY-ID folder removal', () => {
    it('releases only the middle folder chats', () => {
        const first = folder('first'), middle = folder('middle'), next = folder('next')
        const folders = [first, middle, next]
        const chats = [chat('first'), chat('middle'), chat('next')]

        expect(removeChatFolder(folders, chats, middle)).toBe(true)
        expect(folders).toEqual([first, next])
        expect(chats.map(c => c.folderId)).toEqual(['first', null, 'next'])
    })

    it('removes the last folder without throwing', () => {
        const first = folder('first'), last = folder('last')
        const folders = [first, last]
        const chats = [chat('last')]

        expect(removeChatFolder(folders, chats, last)).toBe(true)
        expect(folders).toEqual([first])
        expect(chats[0].folderId).toBeNull()
    })

    it('finds a moved folder by id', () => {
        const first = folder('first'), target = folder('target'), last = folder('last')
        const folders = [first, target, last]
        const chats = [chat('target'), chat('last')]
        folders.splice(1, 1)
        folders.push(target)

        expect(removeChatFolder(folders, chats, { ...target })).toBe(true)
        expect(folders).toEqual([first, last])
        expect(chats.map(c => c.folderId)).toEqual([null, 'last'])
    })

    it('does not change anything when the folder is already gone', () => {
        const present = folder('present')
        const folders = [present]
        const chats = [chat('missing'), chat('present')]

        expect(removeChatFolder(folders, chats, folder('missing'))).toBe(false)
        expect(folders).toEqual([present])
        expect(chats.map(c => c.folderId)).toEqual(['missing', 'present'])
    })

    it('removes a folder without id by identity and releases no chats', () => {
        const target = folder(), other = folder()
        const folders = [target, other]
        const chats = [chat(), chat('other')]

        expect(removeChatFolder(folders, chats, target)).toBe(true)
        expect(folders).toHaveLength(1)
        expect(folders[0]).toBe(other)
        expect(chats.map(c => c.folderId)).toEqual([undefined, 'other'])
    })

    it('keeps chats assigned when a duplicate id remains', () => {
        const target = folder('shared'), duplicate = folder('shared')
        const folders = [target, duplicate]
        const chats = [chat('shared')]

        expect(removeChatFolder(folders, chats, target)).toBe(true)
        expect(folders).toHaveLength(1)
        expect(folders[0]).toBe(duplicate)
        expect(chats[0].folderId).toBe('shared')
    })
})
