import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'

const splitChatOpen = writable(false)
const MobileGUI = writable(false)
const views = { main: { chat: { id: 'left' } as { id: string } | undefined }, side: { chat: { id: 'right' } as { id: string } | undefined } }
vi.mock('../chatSplitPane', () => ({ splitChatOpen, isEmbeddedRisuPane: false }))
vi.mock('../stores.svelte', () => ({ MobileGUI }))
vi.mock('../chatPanes.svelte', () => ({ mainPaneView: views.main, sidePaneView: views.side }))

const { dockPaneFor, paneToasterFor } = await import('./requestToastPane')

describe('paneToasterFor', () => {
    beforeEach(() => {
        splitChatOpen.set(true)
        MobileGUI.set(false)
        views.main.chat = { id: 'left' }
        views.side.chat = { id: 'right' }
    })

    it('puts a reply\'s card over the pane that shows its chat', () => {
        expect(paneToasterFor('right')).toBe('pane-side')
        expect(paneToasterFor('left')).toBe('pane-main')
    })

    it('leaves the window\'s toaster for a chat no pane shows, or without the split', () => {
        expect(paneToasterFor('elsewhere')).toBeUndefined()
        expect(paneToasterFor(undefined)).toBeUndefined()
        splitChatOpen.set(false)
        expect(paneToasterFor('right')).toBeUndefined()
        splitChatOpen.set(true)
        MobileGUI.set(true)
        expect(paneToasterFor('left')).toBeUndefined()
    })

    it('places folded buttons at the measured pane, following chat swaps and split changes', () => {
        const boxes = {
            main: { top: 0, right: 500, left: 0, width: 500 },
            side: { top: 0, right: 0, left: 500, width: 500 },
        }
        expect(dockPaneFor('left', boxes)).toBe('main')
        expect(dockPaneFor('right', boxes)).toBe('side')
        expect(dockPaneFor('elsewhere', boxes)).toBeUndefined()
        expect(dockPaneFor('left', { side: boxes.side })).toBeUndefined()
        views.main.chat = { id: 'right' }
        views.side.chat = { id: 'left' }
        expect(dockPaneFor('left', boxes)).toBe('side')
        splitChatOpen.set(false)
        expect(dockPaneFor('left', boxes)).toBeUndefined()
        splitChatOpen.set(true)
        MobileGUI.set(true)
        expect(dockPaneFor('left', boxes)).toBeUndefined()
        views.main.chat = { id: 'left' }
        views.side.chat = { id: 'right' }
    })
})
