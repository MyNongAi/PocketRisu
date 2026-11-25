// CHAT-LIST-RECENT (2026-11-22): display-only order; indices always refer to the original arrays.
export interface OrderedChat { id?: string; folderId?: string | null; lastDate?: unknown }
export interface OrderedFolder { id: string; nodeOnlyParentFolderId?: string }
export type ChatListItem = { kind: 'chat'; index: number } | { kind: 'folder'; index: number }

const time = (chat: OrderedChat): number | null =>
    typeof chat.lastDate === 'number' && Number.isFinite(chat.lastDate) ? chat.lastDate : null

export function orderChatList(chats: readonly OrderedChat[], folders: readonly OrderedFolder[]): {
    items: ChatListItem[]; folderItems: ChatListItem[][]; folderParents: (number | null)[];
    folderChats: number[][]; looseChats: number[]
} {
    const folderChats = folders.map(() => [] as number[])
    const looseChats: number[] = []
    const folderIndex = new Map(folders.map((folder, index) => [folder.id, index]))
    // CHAT-FOLDER-NESTING (2026-11-25): broken or cyclic parent links appear at the top level.
    const folderParents = folders.map((folder, index): number | null => {
        const parent = folder.nodeOnlyParentFolderId
        if (!parent || !folderIndex.has(parent)) return null
        const visited = new Set<number>([index])
        let next: string | undefined = parent
        while (next && folderIndex.has(next)) {
            const at = folderIndex.get(next)!
            if (visited.has(at)) return null
            visited.add(at)
            next = folders[at].nodeOnlyParentFolderId
        }
        return folderIndex.get(parent)!
    })
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

    const folderItems = folders.map(() => [] as ChatListItem[])
    const items: ChatListItem[] = []
    folders.forEach((_, index) => {
        const item: ChatListItem = { kind: 'folder', index }
        const parent = folderParents[index]
        if (parent === null) items.push(item)
        else folderItems[parent].push(item)
    })
    for (const index of looseChats) items.push({ kind: 'chat', index })
    folderChats.forEach((members, folder) => {
        for (const index of members) folderItems[folder].push({ kind: 'chat', index })
    })
    type Rank = { empty: boolean; at: number | null; index: number }
    const ranks: (Rank | undefined)[] = folders.map(() => undefined)
    const folderRank = (folder: number): Rank => {
        if (ranks[folder]) return ranks[folder]!
        const members = folderChats[folder]
        let at: number | null = null
        let first = Infinity
        for (const chat of members) {
            first = Math.min(first, chat)
            const value = time(chats[chat])
            if (value !== null) at = Math.max(at ?? value, value)
        }
        for (const child of folderItems[folder]) {
            if (child.kind !== 'folder') continue
            const rank = folderRank(child.index)
            if (!rank.empty) {
                first = Math.min(first, rank.index)
                if (rank.at !== null) at = Math.max(at ?? rank.at, rank.at)
            }
        }
        return ranks[folder] = { empty: first === Infinity, at, index: first === Infinity ? folder : first }
    }
    const rank = (item: ChatListItem): Rank => item.kind === 'chat'
        ? { empty: false, at: time(chats[item.index]), index: item.index }
        : folderRank(item.index)
    const compare = (a: ChatListItem, b: ChatListItem) => {
        const ar = rank(a), br = rank(b)
        if (ar.empty !== br.empty) return ar.empty ? -1 : 1
        if (ar.empty && br.empty) return a.index - b.index
        if (ar.at !== null && br.at !== null) return br.at - ar.at || ar.index - br.index || (a.kind === 'folder' ? -1 : 1)
        if (ar.at !== null) return -1
        if (br.at !== null) return 1
        return ar.index - br.index || (a.kind === 'folder' ? -1 : 1)
    }
    items.sort(compare)
    for (const children of folderItems) children.sort(compare)
    return { items, folderItems, folderParents, folderChats, looseChats }
}
