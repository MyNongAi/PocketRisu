import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'

const splitChatOpen = writable(false)
const MobileGUI = writable(false)
const views = { main: { chat: { id: 'left' } as { id: string } | undefined }, side: { chat: { id: 'right' } as { id: string } | undefined } }
vi.mock('../chatSplitPane', () => ({ splitChatOpen, isEmbeddedRisuPane: false }))
vi.mock('../stores.svelte', () => ({ MobileGUI }))
vi.mock('../chatPanes.svelte', () => ({ mainPaneView: views.main, sidePaneView: views.side }))

const { paneToasterFor } = await import('./requestToastPane')

describe('paneToasterFor', () => {
    beforeEach(() => {
        splitChatOpen.set(true)
        MobileGUI.set(false)
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
})
