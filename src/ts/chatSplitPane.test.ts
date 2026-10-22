import { describe, expect, test } from 'vitest'
import { clampSplitWidth, dockedSplitChatRoom, dockedSplitWidths, getSecondaryRisuPaneUrl, getSplitWidthBounds, parseChatRoomDragPayload, serializeChatRoomDragPayload, looseSplitSideWidth, NARROW_SPLIT_PX, paneOverlayFootprint, paneOverlayRailRem } from './chatSplitPane'

describe('clampSplitWidth', () => {
    test('allows either desktop pane to become narrow without collapsing it', () => {
        expect(getSplitWidthBounds(1200)).toEqual({ min: 216, max: 984 })
        expect(clampSplitWidth(1100, 1200)).toBe(984)
        expect(clampSplitWidth(100, 1200)).toBe(216)
    })

    test('keeps a broad drag range on narrow split windows', () => {
        expect(getSplitWidthBounds(700)).toEqual({ min: 160, max: 540 })
        expect(clampSplitWidth(10, 700)).toBe(160)
        expect(clampSplitWidth(900, 700)).toBe(540)
    })

    test('caps the minimum on wide screens and remains safe below 320px', () => {
        expect(getSplitWidthBounds(1920)).toEqual({ min: 280, max: 1640 })
        expect(getSplitWidthBounds(300)).toEqual({ min: 150, max: 150 })
    })

    test('leaves the main chat its minimum at the wide end when given one', () => {
        expect(getSplitWidthBounds(1194, 320)).toEqual({ min: 215, max: 874 })
        expect(getSplitWidthBounds(374, 320)).toEqual({ min: 160, max: 160 })
        expect(clampSplitWidth(Number.MAX_SAFE_INTEGER, 640, 320)).toBe(320)
    })
})

describe('docked split widths', () => {
    // The 80px bot list between the panes (in the span) or at an end (outside it): the same room.
    const between = (window: number, mainPanel = true, sidePanel = true) => ({ span: window, rail: 80, mainPanel, sidePanel })
    const atEnd = (window: number, mainPanel = true, sidePanel = true) => ({ span: window - 80, rail: 0, mainPanel, sidePanel })
    const widths = (mainPanel: number, mainChat: number, sideChat: number, sidePanel: number) => ({ mainPanel, mainChat, sideChat, sidePanel })

    test('the main chat keeps 320px at laptop widths; the second chat gives way, then the panels', () => {
        for (const row of [between, atEnd]) {
            expect(dockedSplitWidths(row(1920), 520)).toEqual(widths(320, 674, 520, 320))
            expect(dockedSplitWidths(row(1366), 520)).toEqual(widths(320, 320, 320, 320))
            expect(dockedSplitWidths(row(1280), 520)).toEqual(widths(320, 320, 234, 320))
            // The second chat at the divider's narrow end still leaves 214px.
            expect(dockedSplitWidths(row(1100), 520)).toEqual(widths(267, 320, 160, 267))
        }
    })

    test('the panels stop at 200px, then the second chat narrows again', () => {
        expect(dockedSplitWidths(atEnd(840), 520)).toEqual(widths(200, 320, 34, 200))
        // Nothing else left to give.
        expect(dockedSplitWidths(atEnd(780), 520)).toEqual(widths(200, 294, 0, 200))
    })

    test('a closed panel leaves its room to the chats', () => {
        expect(dockedSplitWidths(between(1366, false), 520)).toEqual(widths(0, 440, 520, 320))
        expect(dockedSplitWidths(between(1100, true, false), 520)).toEqual(widths(320, 320, 374, 0))
    })

    test('even halves the chats\' room, and the wide end leaves the main chat 320px', () => {
        for (const row of [between, atEnd]) {
            const room = dockedSplitChatRoom(row(1920))
            expect(room).toBe(1194)
            expect(dockedSplitWidths(row(1920), clampSplitWidth(room / 2, room, 320))).toEqual(widths(320, 597, 597, 320))
            expect(dockedSplitWidths(row(1920), clampSplitWidth(Number.MAX_SAFE_INTEGER, room, 320))).toEqual(widths(320, 320, 874, 320))
            const laptop = dockedSplitChatRoom(row(1366))
            expect(dockedSplitWidths(row(1366), clampSplitWidth(laptop / 2, laptop, 320))).toEqual(widths(320, 320, 320, 320))
        }
    })
})

describe('getSecondaryRisuPaneUrl', () => {
    test('opens the whole PocketRisu route as the secondary workspace', () => {
        const url = new URL(getSecondaryRisuPaneUrl(), window.location.href)
        expect(url.pathname).toBe(window.location.pathname)
        expect(url.searchParams.get('pocketrisuPane')).toBe('secondary')
        expect(url.hash).toBe('')
    })
})

describe('chat room split-pane drag payload', () => {
    test('round-trips a character and chat id without accepting partial data', () => {
        const payload = { characterId: 'character-a', chatId: 'chat-b' }
        expect(parseChatRoomDragPayload(serializeChatRoomDragPayload(payload))).toEqual(payload)
        expect(parseChatRoomDragPayload('{"characterId":"character-a"}')).toBeNull()
        expect(parseChatRoomDragPayload('not-json')).toBeNull()
    })
})

describe('a narrow window side by side', () => {
    test('keeps both chats at 320px and stacks below that', () => {
        expect(NARROW_SPLIT_PX).toBe(646)
        // a folded-out phone: the saved width, within both minimums
        expect(looseSplitSideWidth(880, 280)).toBe(320)
        expect(looseSplitSideWidth(880, 400)).toBe(400)
        expect(looseSplitSideWidth(880, 700)).toBe(554)
        expect(looseSplitSideWidth(646, 500)).toBe(320)
    })
})

// A pane's overlay in a narrow split: bot list, panel, and the strip that closes it.
describe('paneOverlayFootprint', () => {
    test('one column fits as before', () => {
        // 498px pane: 80 + 370 + 48
        expect(paneOverlayFootprint(498, paneOverlayRailRem(false, false), 16)).toBe(498)
    })
    test('two columns leave the closing strip in the pane', () => {
        const rail = paneOverlayRailRem(true, false)
        expect(rail).toBe(10)
        // 498px pane: 160 + 290 + 48 (the panel used to stay 370 and push the strip out)
        expect(paneOverlayFootprint(498, rail, 16)).toBe(498)
        expect(paneOverlayFootprint(1200, rail, 16)).toBe(160 + 384 + 48)
    })
    test('the menu sidebar rail is always one column', () => {
        expect(paneOverlayRailRem(true, true)).toBe(5)
    })
    test('a pane too narrow for any panel keeps the list and the strip', () => {
        expect(paneOverlayFootprint(150, 10, 16)).toBe(160 + 48)
    })
})

// Side by side in a narrow window: what a drag can save is what is shown.
describe('looseSplitSideWidth bounds', () => {
    test('both chats keep their minimum', () => {
        expect(looseSplitSideWidth(800, 0)).toBe(320)
        expect(looseSplitSideWidth(800, Number.MAX_SAFE_INTEGER)).toBe(800 - 6 - 320)
    })
})
