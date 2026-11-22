import type { ChatFolder } from './storage/database.svelte'

type FolderOwner = { chatFolders?: ChatFolder[] }
type FolderChat = { id?: string, name: string, folderId?: string }

/**
 * Where a copy or branch of a chat goes when "분기 시 폴더 생성" is on.
 *
 * Copies made at one point of the story share a folder, and a copy made at
 * another point gets a folder of its own; folders stay flat (the user's
 * request, 2026-11-22: copies at messages 5, 6 and 7, two each, make three
 * folders of two). A point is the chat copied and how many messages the new
 * chat shares with it, kept on the folder (`nodeOnlyCopyPoint`). Each copy goes
 * in as it is made; no chat that is already somewhere is moved, except that a
 * loose source joins its first folder, as before.
 */
export function folderForChatCopy(
    owner: FolderOwner,
    source: FolderChat,
    messages: number,
    createFolderOnBranch: boolean,
    makeId: () => string,
): string | undefined {
    if (!createFolderOnBranch) return source.folderId
    const sourceFolder = source.folderId ? owner.chatFolders?.find(folder => folder.id === source.folderId) : undefined
    // A copy of a copy made at the same point joins it, whichever chat of the folder was copied.
    if (sourceFolder?.nodeOnlyCopyPoint?.messages === messages) return sourceFolder.id

    const pointFolder = source.id ? owner.chatFolders?.find(folder =>
        folder.nodeOnlyCopyPoint?.chatId === source.id && folder.nodeOnlyCopyPoint.messages === messages
    ) : undefined
    if (pointFolder) return pointFolder.id

    // A chat named by hand keeps its title, so its folders at other points would
    // read alike: numbered as copies are ("… (2)").
    const base = `Branches of ${source.name}`
    const taken = new Set((owner.chatFolders ?? []).map(folder => folder.name))
    let name = base
    for (let index = 2; taken.has(name); index++) name = `${base} (${index})`
    const folderId = makeId()
    ;(owner.chatFolders ??= []).unshift({
        id: folderId,
        name,
        folded: false,
        nodeOnlyCopyPoint: { chatId: source.id ?? '', messages },
    })
    // A source in another folder (the user's, or one made before points) stays there.
    if (!sourceFolder) source.folderId = folderId
    return folderId
}
