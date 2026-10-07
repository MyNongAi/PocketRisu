import { describe, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'

let current: { id?: string } | undefined
const ReloadGUIPointer = writable(0)
const ReloadChatPointer = writable({} as Record<number, number>)
vi.mock('../storage/database.svelte', () => ({ getCurrentChat: () => current }))
vi.mock('../stores.svelte', () => ({ ReloadGUIPointer, ReloadChatPointer }))

const { isChatOnScreen, reloadChatDisplay, reloadChatMessage } = await import('./chatDisplayReload')

describe('chat display reloads', () => {
    it('redraw only the chat on screen', () => {
        current = { id: 'A' }
        reloadChatDisplay({ id: 'B' })
        reloadChatMessage({ id: 'B' }, 3)
        expect(get(ReloadGUIPointer)).toBe(0)
        expect(get(ReloadChatPointer)).toEqual({})

        // A trigger's working copy of the chat on screen (same id) still redraws it.
        reloadChatDisplay({ id: 'A' })
        reloadChatMessage({ id: 'A' }, '3')
        expect(get(ReloadGUIPointer)).toBe(1)
        expect(get(ReloadChatPointer)).toEqual({ 3: 1 })
    })

    it('keeps the old behaviour for a chat without an id', () => {
        expect(isChatOnScreen({}, { id: 'A' })).toBe(true)
        expect(isChatOnScreen(undefined, { id: 'A' })).toBe(true)
        expect(isChatOnScreen({ id: 'A' }, null)).toBe(false)
    })
})
