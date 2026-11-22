import { describe, expect, it } from 'vitest'
import { orderChatList, type OrderedChat, type OrderedFolder } from './chatListOrder'

const chat = (id: string, lastDate?: unknown, folderId?: string): OrderedChat => ({ id, lastDate, folderId })
const folder = (id: string): OrderedFolder => ({ id })
const labels = (chats: OrderedChat[], folders: OrderedFolder[]) =>
    orderChatList(chats, folders).items.map(item => item.kind === 'folder' ? `f:${folders[item.index].id}` : `c:${chats[item.index].id}`)

describe('CHAT-LIST-RECENT display order', () => {
    it('puts dated chats first, newest first', () => {
        expect(labels([chat('old', 1), chat('none'), chat('new', 3)], [])).toEqual(['c:new', 'c:old', 'c:none'])
    })
    it('uses the newest member time for a folder', () => {
        expect(labels([chat('a', 2, 'f'), chat('b', 5, 'f'), chat('c', 3)], [folder('f')])).toEqual(['f:f', 'c:c'])
    })
    it('puts empty folders on top in folder order', () => {
        expect(labels([chat('a', 9)], [folder('x'), folder('y')])).toEqual(['f:x', 'f:y', 'c:a'])
    })
    it('keeps undated index order and ranks a folder by its lowest member index', () => {
        expect(labels([chat('a'), chat('b', undefined, 'f'), chat('c'), chat('d', undefined, 'f')], [folder('f')])).toEqual(['c:a', 'f:f', 'c:c'])
    })
    it('treats orphan folder chats as loose', () => {
        const result = orderChatList([chat('a', undefined, 'missing')], [folder('f')])
        expect(result.looseChats).toEqual([0])
        expect(labels([chat('a', undefined, 'missing')], [folder('f')])).toEqual(['f:f', 'c:a'])
    })
    it('sorts members inside a folder', () => {
        expect(orderChatList([chat('old', 1, 'f'), chat('none', undefined, 'f'), chat('new', 3, 'f')], [folder('f')]).folderChats[0]).toEqual([2, 0, 1])
    })
    it('ignores non-number and non-finite dates', () => {
        expect(labels([chat('string', '100'), chat('infinity', Infinity), chat('real', 1), chat('nan', NaN)], [])).toEqual(['c:real', 'c:string', 'c:infinity', 'c:nan'])
    })
})
