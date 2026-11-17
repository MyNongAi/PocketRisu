import type { ChatFolder } from './storage/database.svelte'

type FolderOwner = { chatFolders?: ChatFolder[] }
type FolderChat = { name: string, folderId?: string }

// All state is supplied by the caller; this only updates the owner and source when needed.
export function folderForChatCopy(
    owner: FolderOwner,
    source: FolderChat,
    createFolderOnBranch: boolean,
    makeId: () => string,
): string | undefined {
    if (!createFolderOnBranch) return source.folderId
    if (source.folderId && owner.chatFolders?.some(folder => folder.id === source.folderId)) {
        return source.folderId
    }

    const folderId = makeId()
    ;(owner.chatFolders ??= []).unshift({
        id: folderId,
        name: `Branches of ${source.name}`,
        folded: false,
    })
    source.folderId = folderId
    return folderId
}
