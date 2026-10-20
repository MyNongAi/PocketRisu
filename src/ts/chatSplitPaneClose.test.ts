// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import { listenForSplitClose, pressSplitButton, splitChatOpen } from './chatSplitPane'

afterEach(() => splitChatOpen.set(false))

describe('closing the split from its right pane', () => {
    it('closes on the pane\'s own message, and ignores other senders and origins', () => {
        const pane = {} as Window
        const stop = listenForSplitClose(() => pane)
        splitChatOpen.set(true)
        const send = (data: unknown, source: unknown, origin = window.location.origin) =>
            window.dispatchEvent(new MessageEvent('message', { data, source: source as Window, origin }))
        send({ type: 'pocketrisu:split-close' }, {})
        send({ type: 'pocketrisu:split-close' }, pane, 'https://elsewhere.example')
        send({ type: 'something-else' }, pane)
        expect(get(splitChatOpen)).toBe(true)
        send({ type: 'pocketrisu:split-close' }, pane)
        expect(get(splitChatOpen)).toBe(false)
        stop()
        splitChatOpen.set(true)
        send({ type: 'pocketrisu:split-close' }, pane)
        expect(get(splitChatOpen)).toBe(true)
    })

    it('toggles in the main window', () => {
        pressSplitButton()
        expect(get(splitChatOpen)).toBe(true)
        pressSplitButton()
        expect(get(splitChatOpen)).toBe(false)
    })
})

describe('splitRightInset', () => {
    it('is the right pane plus its divider while split, else 0', async () => {
        const { splitRightInset, SPLIT_DIVIDER_PX } = await import('./chatSplitPane')
        expect(splitRightInset(true, 520, false)).toBe(520 + SPLIT_DIVIDER_PX)
        expect(splitRightInset(false, 520, false)).toBe(0)
        expect(splitRightInset(true, 520, true)).toBe(0)
    })

    it('docked side by side, is everything right of the main chat', async () => {
        const { splitRightInset } = await import('./chatSplitPane')
        // The bot list between the panes or at the end, the second panel open.
        expect(splitRightInset(true, 520, false, { row: true, rail: 80, sideChat: 320, sidePanel: 320 })).toBe(6 + 80 + 320 + 320)
        // The bot list at the start, the second panel closed: the laid-out chat, not the saved width.
        expect(splitRightInset(true, 520, false, { row: true, rail: 0, sideChat: 400, sidePanel: 0 })).toBe(6 + 400)
        expect(splitRightInset(true, 520, true, { row: true, rail: 80, sideChat: 320, sidePanel: 320 })).toBe(0)
    })

    it('stacked, is only the bot list at the end', async () => {
        const { splitRightInset } = await import('./chatSplitPane')
        expect(splitRightInset(true, 520, false, { row: false, rail: 0, sideChat: 0, sidePanel: 0 })).toBe(0)
        expect(splitRightInset(true, 520, false, { row: false, rail: 80, sideChat: 0, sidePanel: 0 })).toBe(80)
    })
})
