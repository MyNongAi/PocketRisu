import { describe, expect, test, vi } from 'vitest'

// A send's summaries read the HypaV3 preset of the chat being sent, not of
// the chat on screen: moving to a chat with memory off while a long summary
// ran failed its next part "Preset not found" (the user's log, 2026-10-26).

const mocks = vi.hoisted(() => ({
    db: {} as any,
    current: null as any,
    requestChatData: vi.fn(),
}))

vi.mock('../request/request', () => ({ requestChatData: mocks.requestChatData }))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
    getCurrentCharacter: () => mocks.current,
    getCurrentChat: () => mocks.current?.chats?.[mocks.current.chatPage],
}))

import { getCurrentHypaV3Preset, summarize } from './hypav3'
import { createMemoryPreset } from './memoryPresets'

describe('getCurrentHypaV3Preset', () => {
    const memory = createMemoryPreset('Summary', 'p1')
    const sending = { chaId: 'a', chatPage: 0, chats: [{ id: 'a0', memoryPresetId: 'p1' }] } as any
    const onScreen = { chaId: 'b', chatPage: 0, chats: [{ id: 'b0', memoryPresetId: 'off' }] } as any

    test("reads the sending chat's preset while another chat is on screen", () => {
        mocks.db = { memoryPresets: [memory], memoryPresetId: 'off' }
        mocks.current = onScreen

        expect(getCurrentHypaV3Preset(sending, sending.chats[0]).name).toBe('Summary')
        expect(() => getCurrentHypaV3Preset()).toThrow('Preset not found')
    })

    test("a summary for a send uses that chat's preset and hears the send's stop", async () => {
        mocks.db = { memoryPresets: [memory], memoryPresetId: 'off' }
        mocks.current = onScreen
        mocks.requestChatData.mockReset()
        mocks.requestChatData.mockResolvedValue({ type: 'success', result: 'summary' })
        const stop = new AbortController()

        const result = await summarize([{ role: 'user', content: 'hello' }], false, {
            currentChar: sending,
            currentChat: sending.chats[0],
            routeSnapshot: { kind: 'classic', aiModel: 'echo_model', providerKey: 'classic:echo_model', fallbackModels: [] },
            abortSignal: stop.signal,
        })

        expect(result).toBe('summary')
        expect(mocks.requestChatData).toHaveBeenCalledTimes(1)
        expect(mocks.requestChatData.mock.calls[0][1]).toBe('memory')
        expect(mocks.requestChatData.mock.calls[0][2]).toBe(stop.signal)
    })

    test('without a chat it still reads the chat on screen', () => {
        mocks.db = { memoryPresets: [memory], memoryPresetId: 'off' }
        mocks.current = sending

        expect(getCurrentHypaV3Preset().name).toBe('Summary')
    })
})
