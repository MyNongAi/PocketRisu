import { describe, expect, it, vi } from 'vitest'
import {
    captureChatViewportAnchor,
    getChatRoomIdentity,
    restoreChatViewportAnchor,
} from './chatViewportAnchor'

function rect(top: number, bottom: number): DOMRect {
    return { top, bottom, left: 0, right: 400, width: 400, height: bottom - top } as DOMRect
}

describe('chat viewport anchoring', () => {
    it('finds a replaced streaming message by its stable chat index', () => {
        const scroller = document.createElement('div')
        const body = document.createElement('div')
        scroller.append(body)
        scroller.scrollTop = -250
        vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(0, 500))
        const oldMessage = document.createElement('div')
        oldMessage.dataset.chatIndex = '4'
        vi.spyOn(oldMessage, 'getBoundingClientRect').mockReturnValue(rect(100, 160))
        body.append(oldMessage)

        const anchor = captureChatViewportAnchor(body, scroller, 'char-a/chat-a')
        const newMessage = document.createElement('div')
        newMessage.dataset.chatIndex = '4'
        vi.spyOn(newMessage, 'getBoundingClientRect').mockReturnValue(rect(220, 280))
        oldMessage.replaceWith(newMessage)

        restoreChatViewportAnchor(body, scroller, anchor)
        expect(scroller.scrollTop).toBe(-130)
    })

    it('falls back to the captured scroll position when no message survives', () => {
        const scroller = document.createElement('div')
        const body = document.createElement('div')
        scroller.append(body)
        scroller.scrollTop = -300
        vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(0, 500))

        const anchor = captureChatViewportAnchor(body, scroller, 'char-a/chat-a')
        scroller.scrollTop = -10
        restoreChatViewportAnchor(body, scroller, anchor)
        expect(scroller.scrollTop).toBe(-300)
    })

    it('uses each split pane’s own character and chat as its identity', () => {
        const left = { chaId: 'left', chatPage: 0, chats: [{ id: 'room' }] }
        const right = { chaId: 'right', chatPage: 0, chats: [{ id: 'room' }] }
        expect(getChatRoomIdentity(left)).toBe('left/room')
        expect(getChatRoomIdentity(right)).toBe('right/room')
    })
})
