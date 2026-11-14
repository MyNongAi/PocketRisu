import { inputEchoKey } from './inputEcho'

/** Open original-text editors live only in memory, across Chat remounts. */
export type MessageEditIdentity = {
    chaId: string
    chatId?: string
    chatIndex: number
    messageKey: string
    role: string
}

type OpenEdit = { text: string, role: string }
const openEdits = new Map<string, OpenEdit>()

export function messageEditScope(identity: Pick<MessageEditIdentity, 'chaId' | 'chatId' | 'chatIndex'>): string {
    return JSON.stringify([
        identity.chaId,
        identity.chatId ? `id:${identity.chatId}` : `index:${identity.chatIndex}`,
    ])
}

function key(identity: MessageEditIdentity): string {
    return JSON.stringify([messageEditScope(identity), identity.messageKey])
}

export function openMessageEdit(identity: MessageEditIdentity, text: string): void {
    openEdits.set(key(identity), { text, role: identity.role })
}

export function readMessageEdit(identity: MessageEditIdentity): string | undefined {
    const entry = openEdits.get(key(identity))
    if (entry && entry.role !== identity.role) {
        // An index-only key can now point at another message.
        openEdits.delete(key(identity))
        return undefined
    }
    return entry?.text
}

export function updateMessageEdit(identity: MessageEditIdentity, text: string): void {
    const entry = openEdits.get(key(identity))
    if (entry && entry.role === identity.role) entry.text = text
}

export function closeMessageEdit(identity: MessageEditIdentity): void {
    openEdits.delete(key(identity))
}

/** Find the message again when an inserted message has shifted its index. */
export function messageEditIndex(
    messages: readonly ({ chatId?: string, role?: string } | undefined)[],
    identity: MessageEditIdentity,
    index: number,
): number {
    if (index >= 0 && messages[index]?.role === identity.role && inputEchoKey(messages[index], index) === identity.messageKey) return index
    if (!identity.messageKey.startsWith('id:')) return -1
    return messages.findIndex((message, i) => message?.role === identity.role && inputEchoKey(message, i) === identity.messageKey)
}
