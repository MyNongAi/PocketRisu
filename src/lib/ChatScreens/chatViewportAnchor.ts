export type ChatViewportAnchor = {
    element: HTMLElement | null
    messageIndex: number | null
    offsetTop: number
    scrollTop: number
    roomId: string | null
}

/** Split panes must use their own character, not the globally selected pane. */
export function getChatRoomIdentity(character: {
    chaId?: string
    chatPage?: number
    chats?: Array<{ id?: string } | null>
} | null | undefined): string | null {
    const chatId = character?.chats?.[character.chatPage ?? -1]?.id
    return character?.chaId && chatId ? `${character.chaId}/${chatId}` : null
}

/** Capture the visible message, not just scrollTop, in a reversed chat list. */
export function captureChatViewportAnchor(
    body: HTMLElement,
    scroller: HTMLElement,
    roomId: string | null,
): ChatViewportAnchor {
    const scrollerRect = scroller.getBoundingClientRect()
    const element = Array.from(body.querySelectorAll<HTMLElement>('[data-chat-index]'))
        .filter(candidate => {
            const rect = candidate.getBoundingClientRect()
            return rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom
        })
        .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)[0] ?? null
    const index = element ? Number(element.dataset.chatIndex) : NaN

    return {
        element,
        messageIndex: Number.isInteger(index) ? index : null,
        offsetTop: element ? element.getBoundingClientRect().top - scrollerRect.top : 0,
        scrollTop: scroller.scrollTop,
        roomId,
    }
}

/**
 * A streamed message or asset-window change can replace its entire DOM node.
 * Re-find that message by index before giving up on viewport preservation.
 */
export function restoreChatViewportAnchor(
    body: HTMLElement,
    scroller: HTMLElement,
    anchor: ChatViewportAnchor,
): void {
    let element = anchor.element && body.contains(anchor.element) ? anchor.element : null
    if (!element && anchor.messageIndex !== null) {
        element = Array.from(body.querySelectorAll<HTMLElement>('[data-chat-index]'))
            .find(candidate => Number(candidate.dataset.chatIndex) === anchor.messageIndex) ?? null
    }
    if (!element) {
        scroller.scrollTop = anchor.scrollTop
        return
    }
    const delta = element.getBoundingClientRect().top
        - scroller.getBoundingClientRect().top
        - anchor.offsetTop
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
}
