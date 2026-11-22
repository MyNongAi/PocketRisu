// CHAT-LIST-RECENT (2026-11-22): display-only order; indices always refer to the original arrays.
export interface OrderedChat { id?: string; folderId?: string | null; lastDate?: unknown }
export interface OrderedFolder { id: string }
export type ChatListItem = { kind: 'chat'; index: number } | { kind: 'folder'; index: number }

const time = (chat: OrderedChat): number | null =>
    typeof chat.lastDate === 'number' && Number.isFinite(chat.lastDate) ? chat.lastDate : null

export function orderChatList(chats: readonly OrderedChat[], folders: readonly OrderedFolder[]): {
    items: ChatListItem[]; folderChats: number[][]; looseChats: number[]
} {
    const folderChats = folders.map(() => [] as number[])
    const looseChats: number[] = []
    const folderIndex = new Map(folders.map((folder, index) => [folder.id, index]))
    chats.forEach((chat, index) => {
        const target = chat.folderId == null ? undefined : folderIndex.get(chat.folderId)
        if (target === undefined) looseChats.push(index)
        else folderChats[target].push(index)
    })
    const compareChats = (a: number, b: number) => {
        const at = time(chats[a]), bt = time(chats[b])
        if (at !== null && bt !== null) return bt - at || a - b
        if (at !== null) return -1
        if (bt !== null) return 1
        return a - b
    }
    for (const members of folderChats) members.sort(compareChats)
    looseChats.sort(compareChats)
    const items: ChatListItem[] = [
        ...folders.map((_, index): ChatListItem => ({ kind: 'folder', index })),
        ...looseChats.map(index => ({ kind: 'chat', index }) as ChatListItem),
    ]
    const rank = (item: ChatListItem) => {
        if (item.kind === 'chat') return { empty: false, at: time(chats[item.index]), index: item.index }
        const members = folderChats[item.index]
        return { empty: members.length === 0, at: members.reduce<number | null>((newest, index) => {
            const value = time(chats[index])
            return value === null ? newest : Math.max(newest ?? value, value)
        }, null), index: members.length ? Math.min(...members) : item.index }
    }
    items.sort((a, b) => {
        const ar = rank(a), br = rank(b)
        if (ar.empty !== br.empty) return ar.empty ? -1 : 1
        if (ar.empty && br.empty) return a.index - b.index
        if (ar.at !== null && br.at !== null) return br.at - ar.at || ar.index - br.index || (a.kind === 'folder' ? -1 : 1)
        if (ar.at !== null) return -1
        if (br.at !== null) return 1
        return ar.index - br.index || (a.kind === 'folder' ? -1 : 1)
    })
    return { items, folderChats, looseChats }
}
