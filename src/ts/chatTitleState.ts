// How a chat's title came about, for its color in the chat lists (the user's
// request, 2026-10-17):
// - 'auto': the last input's first line (CHAT-TITLE-LAST-INPUT), white;
// - 'manual': renamed by the user, green, and no longer replaced by inputs;
// - 'stale': a renamed title the chat has answered past since, yellow.
// Clearing a renamed title hands it back to the last input.
//
// Kept on the character (nodeOnlyChatTitles, chat id -> state), which is
// always loaded, rather than on each chat's catalog stub: chats that are not
// loaded show the right color too, and the chat storage format is untouched.

export type ChatTitleState = 'auto' | 'manual' | 'stale'

export interface ChatTitleHolder {
    nodeOnlyChatTitles?: Record<string, 'manual' | 'stale'>
    chats?: readonly ({ id?: string } | null | undefined)[]
}

export function chatTitleState(holder: ChatTitleHolder | null | undefined, chatId: string | undefined): ChatTitleState {
    if (!holder || !chatId) return 'auto'
    return holder.nodeOnlyChatTitles?.[chatId] ?? 'auto'
}

/** Tailwind text color for a title in that state ('' = the normal text color). */
export function chatTitleClass(state: ChatTitleState): string {
    if (state === 'manual') return 'text-green-400'
    if (state === 'stale') return 'text-yellow-400'
    return ''
}

function write(holder: ChatTitleHolder, chatId: string, state: 'manual' | 'stale' | null): void {
    const live = new Set((holder.chats ?? []).map((chat) => chat?.id).filter((id): id is string => !!id))
    const next: Record<string, 'manual' | 'stale'> = {}
    for (const [id, value] of Object.entries(holder.nodeOnlyChatTitles ?? {})) {
        if (id !== chatId && live.has(id)) next[id] = value
    }
    if (state) next[chatId] = state
    if (Object.keys(next).length > 0) holder.nodeOnlyChatTitles = next
    else delete holder.nodeOnlyChatTitles
}

/** The user typed a title for this chat. */
export function markChatTitleManual(holder: ChatTitleHolder, chatId: string | undefined): void {
    if (!chatId || holder.nodeOnlyChatTitles?.[chatId] === 'manual') return
    write(holder, chatId, 'manual')
}

/** Back to the automatic title (the user cleared the name). */
export function clearChatTitleManual(holder: ChatTitleHolder, chatId: string | undefined): void {
    if (!chatId || !holder.nodeOnlyChatTitles?.[chatId]) return
    write(holder, chatId, null)
}

/** A reply finished in this chat: a fresh renamed title is now behind it. */
export function ageManualChatTitle(holder: ChatTitleHolder, chatId: string | undefined): void {
    if (!chatId || holder.nodeOnlyChatTitles?.[chatId] !== 'manual') return
    write(holder, chatId, 'stale')
}
