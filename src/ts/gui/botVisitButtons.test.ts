import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'
import type { PaneId } from '../chatPanes.svelte'
import type { BotVisitHistory } from './botVisitHistory'

const db = { characters: [{ chaId: 'a' }, { chaId: 'b' }, { chaId: 'c' }, { chaId: 'd' }] }
const selectedCharID = writable(1)
const settingsOpen = writable(false)
const MobileGUI = writable(false)
const splitChatOpen = writable(true)
const paneState = { active: 'main' as PaneId, home: { main: false, side: false } }
const opened: string[] = []
let paneBotVisits: (pane: PaneId) => BotVisitHistory

vi.mock('../stores.svelte', () => ({ selectedCharID, settingsOpen, MobileGUI }))
vi.mock('../storage/database.svelte', () => ({ getDatabase: () => db }))
vi.mock('../chatPanes.svelte', () => ({ paneState }))
vi.mock('../chatSplitPane', () => ({ splitChatOpen, isEmbeddedRisuPane: false }))
vi.mock('../paneActivation', () => ({
    activatePane: vi.fn((pane: PaneId) => {
        paneState.active = pane
        selectedCharID.set(pane === 'side' ? 3 : 1)
        return true
    }),
}))
vi.mock('../characters', () => ({
    changeChar: vi.fn((index: number) => {
        const id = db.characters[index].chaId
        opened.push(id)
        selectedCharID.set(index)
        paneBotVisits(paneState.active).record(id)
    }),
}))

let stepBotVisit: (direction: -1 | 1, event: MouseEvent) => void
let activatePane: ReturnType<typeof vi.fn>

function pressInside(root: Element, direction: -1 | 1): void {
    const child = document.createElement('span')
    root.append(child)
    root.addEventListener('mouseup', (event) => stepBotVisit(direction, event as MouseEvent), { once: true })
    child.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: direction < 0 ? 3 : 4 }))
}

describe('SPLIT-PANE-BOT-VISITS (2026-11-25): mouse history follows the pointer pane', () => {
    beforeEach(async () => {
        vi.resetModules()
        ;({ paneBotVisits } = await import('./botVisitHistory'))
        ;({ stepBotVisit } = await import('./botVisitButtons'))
        activatePane = (await import('../paneActivation')).activatePane as unknown as ReturnType<typeof vi.fn>
        paneState.active = 'main'
        paneState.home = { main: false, side: false }
        selectedCharID.set(1)
        settingsOpen.set(false)
        splitChatOpen.set(true)
        opened.length = 0
        activatePane.mockClear()
        paneBotVisits('main').record('a')
        paneBotVisits('main').record('b')
        paneBotVisits('side').record('c')
        paneBotVisits('side').record('d')
    })

    it('activates the side pane under the mouse and steps only through its bots', () => {
        const side = document.createElement('div')
        side.setAttribute('data-chat-pane', 'side')
        pressInside(side, -1)
        expect(activatePane).toHaveBeenCalledWith('side')
        expect(opened).toEqual(['c'])
        expect(paneBotVisits('side').visits).toEqual(['c', 'd'])
        expect(paneBotVisits('main').visits).toEqual(['a', 'b'])
    })

    it('uses the active pane outside either pane, and the main history without a split', () => {
        pressInside(document.createElement('div'), -1)
        expect(opened).toEqual(['a'])
        opened.length = 0
        splitChatOpen.set(false)
        paneState.active = 'side'
        selectedCharID.set(3)
        settingsOpen.set(true)
        pressInside(document.createElement('div'), -1)
        expect(activatePane).toHaveBeenCalledWith('main')
        expect(opened).toEqual(['a'])
    })

    it('back from a side pane at Home opens its current visit', () => {
        paneState.active = 'side'
        paneState.home.side = true
        selectedCharID.set(-1)
        pressInside(document.createElement('div'), -1)
        expect(opened).toEqual(['d'])
    })
})
