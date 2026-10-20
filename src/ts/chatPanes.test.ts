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
const MobileGUI = writable(false)

vi.mock('./stores.svelte', () => ({ DBState: { db }, selIdState, selectedCharID, chatDeselected: writable(false), botMakerMode, QuickSettings, MobileGUI }))
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
vi.mock('./storage/chatStorage', () => ({ ensureChatHydrated: vi.fn(async (): Promise<unknown> => null) }))

const { chatsShownBesideSelection, locateChat, mainPaneView, paneState, paneToggles, selectionPaneView, shownBesideSelection, sidePaneView } = await import('./chatPanes.svelte')
const { activatePane, restorePanesAfterBoot, returnToMainPane, showInSidePane, swapPanes } = await import('./paneActivation')
const { splitLayout } = await import('./splitLayout.svelte')
const { splitChatOpen } = await import('./chatSplitPane')
const { ensureChatHydrated } = await import('./storage/chatStorage')

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
        splitChatOpen.set(true)
        MobileGUI.set(false)
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

    it('a chat taking the selection back drops what its pane kept, so it is never laid over newer values', () => {
        showInSidePane({ chaId: 'b', chatId: 'b1' })
        toggles.toggle_sw = '1'
        activatePane('side')
        activatePane('main')
        expect(toggles.toggle_sw).toBe('1')
        expect(paneToggles.a1).toBeUndefined()
        expect(paneToggles.b1).toBeDefined()
        expect(JSON.parse(localStorage.getItem('pocketrisu:split-chat:toggles') ?? '{}').a1).toBeUndefined()
        // switched off in the main pane, then a reload with nothing selected:
        // an entry an earlier version left is not applied over the live value
        toggles.toggle_sw = '0'
        paneToggles.a1 = { toggle_sw: '1' }
        selectedCharID.set(-1)
        applied.length = 0
        restorePanesAfterBoot()
        expect(get(selectedCharID)).toBe(0)
        expect(applied).toEqual([])
        expect(toggles.toggle_sw).toBe('0')
        expect(paneToggles.a1).toBeUndefined()
    })

    it("a chat dropped on the side pane keeps its own toggles, not the active pane's live ones", () => {
        toggles.toggle_sw = '1'
        showInSidePane({ chaId: 'b', chatId: 'b1' })
        toggles.toggle_sw = '0'
        expect(paneToggles.b1).toEqual({ toggle_sw: '1' })
        // touched, it takes them with it
        activatePane('side')
        expect(toggles.toggle_sw).toBe('1')
        expect(paneToggles.a1).toEqual({ toggle_sw: '0' })
    })

    it('a pinned chat dropped on the side pane keeps the live values under its pin', () => {
        const b1 = db.characters[1].chats[0] as any
        b1.savedToggleValues = { toggle_pin: '1' }
        b1.savedToggleUnsetKeys = ['toggle_unset']
        try {
            Object.assign(toggles, { toggle_sw: '1', toggle_pin: '0', toggle_unset: '1' })
            showInSidePane({ chaId: 'b', chatId: 'b1' })
            expect(paneToggles.b1).toEqual({ toggle_sw: '1', toggle_pin: '1' })
            // dropped again, it keeps what it already kept
            paneToggles.b1.toggle_sw = '2'
            showInSidePane({ chaId: 'b', chatId: 'b1' })
            expect(paneToggles.b1.toggle_sw).toBe('2')
        } finally {
            delete b1.savedToggleValues
            delete b1.savedToggleUnsetKeys
        }
    })

    it('a chat stub dropped on the side pane gets its pin once loaded', async () => {
        const stub = db.characters[1].chats[0]
        db.characters[1].chats[0] = { id: 'b1', message: [], _placeholder: true } as any
        const loaded = { id: 'b1', message: [], savedToggleValues: { toggle_pin: '1' } }
        vi.mocked(ensureChatHydrated).mockImplementationOnce(async () => {
            db.characters[1].chats[0] = loaded as any
            return loaded as any
        })
        try {
            toggles.toggle_sw = '1'
            showInSidePane({ chaId: 'b', chatId: 'b1' })
            expect(paneToggles.b1).toEqual({ toggle_sw: '1' })
            toggles.toggle_sw = '0'
            await vi.waitFor(() => expect(paneToggles.b1).toEqual({ toggle_sw: '1', toggle_pin: '1' }))
        } finally {
            db.characters[1].chats[0] = stub
        }
    })

    it('the selected chat dropped on the side pane keeps nothing: both panes show the live values', () => {
        showInSidePane({ chaId: 'a', chatId: 'a1' })
        expect(paneToggles.a1).toBeUndefined()
        expect(shownBesideSelection('a1')).toBe(false)
    })

    it('a chat has toggles of its own only while the split on screen shows it beside the selection', () => {
        expect(shownBesideSelection('b1')).toBe(false)
        showInSidePane({ chaId: 'b', chatId: 'b1' })
        expect(shownBesideSelection('b1')).toBe(true)
        expect(shownBesideSelection('a1')).toBe(false)
        // the active pane's own chat, with nothing selected (Home)
        selectedCharID.set(-1)
        paneState.held.main = { chaId: 'a', chatId: 'a1' }
        expect(shownBesideSelection('a1')).toBe(false)
        // a closed split, or the phone layout, shows one chat
        splitChatOpen.set(false)
        expect(shownBesideSelection('b1')).toBe(false)
        splitChatOpen.set(true)
        MobileGUI.set(true)
        expect(shownBesideSelection('b1')).toBe(false)
    })

    it("outside any pane (a narrow window's sidebar, the popup editor) the view follows the selection", () => {
        // no split: the main pane, as before
        expect(selectionPaneView.pane).toBe('main')
        expect(selectionPaneView.chat?.id).toBe(mainPaneView.chat?.id)
        showInSidePane({ chaId: 'b', chatId: 'b1' })
        activatePane('side')
        expect(selectionPaneView.pane).toBe('side')
        expect(selectionPaneView.active).toBe(true)
        expect(selectionPaneView.characterIndex).toBe(1)
        expect(selectionPaneView.chat?.id).toBe('b1')
        activatePane('main')
        expect(selectionPaneView.pane).toBe('main')
        expect(selectionPaneView.chat?.id).toBe('a1')
    })
})
