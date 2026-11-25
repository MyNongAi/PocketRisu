import { describe, expect, it } from 'vitest'
import { matchesScrollRequest, paneMayRedraw, PaneRedrawGate, roomChanged } from './paneRedraw'

describe('SPLIT-PANE-ISOLATION (2026-11-25)', () => {
    it('allows the active pane, including the only pane, and the selected chat in either pane', () => {
        expect(paneMayRedraw(true, 'a', 'b')).toBe(true)
        expect(paneMayRedraw(true, 'a', 'a')).toBe(true)
        expect(paneMayRedraw(false, 'a', 'a')).toBe(true)
        expect(paneMayRedraw(false, 'a', 'b')).toBe(false)
        expect(paneMayRedraw(false, undefined, undefined)).toBe(false)
    })

    it('remembers skipped redraws and catches up once', () => {
        const gate = new PaneRedrawGate()
        expect(gate.signal(false)).toBe(false)
        expect(gate.signal(false)).toBe(false)
        expect(gate.revision).toBe(0)
        expect(gate.catchUp(false)).toBe(false)
        expect(gate.catchUp(true)).toBe(true)
        expect(gate.revision).toBe(1)
        expect(gate.catchUp(true)).toBe(false)
    })

    it('targets only the requested pane, chat, and latest serial', () => {
        const request = { pane: 'side' as const, chatId: 'a', index: 3, serial: 2 }
        expect(matchesScrollRequest(request, 'side', 'a', 2)).toBe(true)
        expect(matchesScrollRequest(request, 'main', 'a', 2)).toBe(false)
        expect(matchesScrollRequest(request, 'side', 'b', 2)).toBe(false)
        expect(matchesScrollRequest(request, 'side', 'a', 3)).toBe(false)
    })

    it('does not turn a missing room into a chat switch', () => {
        expect(roomChanged('a', null)).toBe(false)
        expect(roomChanged('a', 'a')).toBe(false)
        expect(roomChanged('a', 'b')).toBe(true)
    })
})
