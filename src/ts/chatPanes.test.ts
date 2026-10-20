import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'

const db = {
    characters: [
        { chaId: 'a', chatPage: 0, chats: [{ id: 'a1', message: [] }, { id: 'a2', message: [] }] },
        { chaId: 'b', chatPage: 0, chats: [{ id: 'b1', message: [] }] },
    ],
}
const selIdState = { selId: 0 }
const selectedCharID = writable(0)
selectedCharID.subscribe((value) => { selIdState.selId = value })
const loadTogglesFromChat = vi.fn()
const botMakerMode = writable(false)
const QuickSettings = { open: false, index: 0 }
const toggles: Record<string, string> = {}
const applied: Record<string, string>[] = []

vi.mock('./stores.svelte', () => ({ DBState: { db }, selIdState, selectedCharID, chatDeselected: writable(false), botMakerMode, QuickSettings }))
vi.mock('./storage/database.svelte', () => ({
    getDatabase: () => db,
    loadTogglesFromChat: (...args: unknown[]) => loadTogglesFromChat(...args),
    snapshotToggleValues: () => ({ ...toggles }),
    applyToggleValues: (values: Record<string, string>) => {
        applied.push(values)
        for (const key of Object.keys(toggles)) delete toggles[key]
        Object.assign(toggles, values)
    },
}))
vi.mock('./storage/chatStorage', () => ({ ensureChatHydrated: vi.fn(async () => null) }))

const { chatsShownBesideSelection, locateChat, mainPaneView, paneState, paneToggles, sidePaneView } = await import('./chatPanes.svelte')
const { activatePane, returnToMainPane, showInSidePane, swapPanes } = await import('./paneActivation')
const { splitLayout } = await import('./splitLayout.svelte')

describe('the two panes of the split', () => {
    beforeEach(() => {
        localStorage.clear()
        db.characters[0].chatPage = 0
        selectedCharID.set(0)
        paneState.active = 'main'
        paneState.held = { main: null, side: null }
        loadTogglesFromChat.mockClear()
        botMakerMode.set(false)
        QuickSettings.open = false
        splitLayout.tab = { main: 'chat', side: 'chat' }
        for (const key of Object.keys(paneToggles)) delete paneToggles[key]
        for (const key of Object.keys(toggles)) delete toggles[key]
        applied.length = 0
    })

    it('finds a chat by its ids wherever it now is', () => {
        expect(locateChat(db.characters, { chaId: 'b', chatId: 'b1' })).toEqual({ characterIndex: 1, chatIndex: 0 })
        expect(locateChat(db.characters, { chaId: 'a', chatId: 'gone' })).toBeNull()
        expect(locateChat(db.characters, null)).toBeNull()
    })

    it('touching the side pane hands it the selection; the main pane keeps its chat', () => {
        expect(showInSidePane({ chaId: 'b', chatId: 'b1' })).toBe(true)
        expect(sidePaneView.chat?.id).toBe('b1')
        expect(mainPaneView.chat?.id).toBe('a1')
        expect(chatsShownBesideSelection(true)).toEqual([{ chaId: 'b', chatId: 'b1' }])

        expect(activatePane('side')).toBe(true)
        expect(get(selectedCharID)).toBe(1)
        expect(loadTogglesFromChat).toHaveBeenCalledWith(db.characters[1].chats[0])
        expect(sidePaneView.active).toBe(true)
        expect(mainPaneView.chat?.id).toBe('a1')
        expect(chatsShownBesideSelection(true)).toEqual([{ chaId: 'a', chatId: 'a1' }])
        expect(chatsShownBesideSelection(false)).toEqual([])

        // back again
        expect(activatePane('main')).toBe(true)
        expect(get(selectedCharID)).toBe(0)
        expect(sidePaneView.chat?.id).toBe('b1')
    })

    it('two chats of one bot: the selected one is its chatPage, the other is kept by id', () => {
        showInSidePane({ chaId: 'a', chatId: 'a2' })
        activatePane('side')
        expect(db.characters[0].chatPage).toBe(1)
        expect(sidePaneView.chat?.id).toBe('a2')
        expect(mainPaneView.chat?.id).toBe('a1')
        activatePane('main')
        expect(db.characters[0].chatPage).toBe(0)
        expect(sidePaneView.chat?.id).toBe('a2')
    })

    it('an empty side pane takes the selection with no chat; the sidebar then opens one there', () => {
        expect(activatePane('side')).toBe(true)
        expect(get(selectedCharID)).toBe(-1)
        expect(mainPaneView.chat?.id).toBe('a1')
        selectedCharID.set(1)
        expect(sidePaneView.chat?.id).toBe('b1')
        // the split closes: the main pane takes the selection back
        returnToMainPane()
        expect(paneState.active).toBe('main')
        expect(get(selectedCharID)).toBe(0)
        expect(paneState.held.side).toEqual({ chaId: 'b', chatId: 'b1' })
    })

    it('an empty main pane takes the selection too, so the sidebar can open a bot there', () => {
        paneState.active = 'side'
        paneState.held.main = null
        expect(activatePane('main')).toBe(true)
        expect(get(selectedCharID)).toBe(-1)
        expect(paneState.held.side).toEqual({ chaId: 'a', chatId: 'a1' })
        expect(sidePaneView.chat?.id).toBe('a1')
    })

    it("each pane keeps its toggles and its panel tab (the user's request, 2026-10-21)", () => {
        showInSidePane({ chaId: 'b', chatId: 'b1' })
        toggles.toggle_sw = '1'
        botMakerMode.set(true)
        activatePane('side')
        // the main chat's values and tab are kept for it; the side pane opens on its own tab
        expect(paneToggles.a1).toEqual({ toggle_sw: '1' })
        expect(splitLayout.tab.main).toBe('character')
        expect(get(botMakerMode)).toBe(false)
        // the side pane switches it off; back on the main pane it is on again
        toggles.toggle_sw = '0'
        activatePane('main')
        expect(paneToggles.b1).toEqual({ toggle_sw: '0' })
        expect(toggles.toggle_sw).toBe('1')
        expect(get(botMakerMode)).toBe(true)
    })

    it("swaps the two panes' chats; the touched pane stays the active one", () => {
        showInSidePane({ chaId: 'b', chatId: 'b1' })
        swapPanes()
        expect(paneState.active).toBe('main')
        expect(get(selectedCharID)).toBe(1)
        expect(mainPaneView.chat?.id).toBe('b1')
        expect(sidePaneView.chat?.id).toBe('a1')
    })
})
