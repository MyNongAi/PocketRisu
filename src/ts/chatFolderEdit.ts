// CHAT-FOLDER-DELETE-BY-ID (2026-11-25): Svelte 5 passes snippet arguments as getters.
// After a folder is spliced out, reading that getter can point to the next folder or undefined.
// Capture the target before awaiting confirmation and find its current index by id before removal.
export interface EditableChatFolder { id?: string }
export interface EditableChat { folderId?: string | null }

/** Removes a folder and releases only chats that no remaining folder owns. */
export function removeChatFolder<F extends EditableChatFolder>(folders: F[], chats: EditableChat[], target: F): boolean {
    const index = target.id ? folders.findIndex(f => f?.id === target.id) : folders.indexOf(target)
    if (index === -1) return false

    folders.splice(index, 1)
    if (target.id && !folders.some(f => f?.id === target.id)) {
        for (const chat of chats) {
            if (chat.folderId === target.id) chat.folderId = null
        }
    }
    return true
}
