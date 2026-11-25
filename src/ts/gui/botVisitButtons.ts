import { get } from 'svelte/store'
import { changeChar } from '../characters'
import { getDatabase } from '../storage/database.svelte'
import { MobileGUI, selectedCharID, settingsOpen } from '../stores.svelte'
import { paneState, type PaneId } from '../chatPanes.svelte'
import { activatePane } from '../paneActivation'
import { isEmbeddedRisuPane, splitChatOpen } from '../chatSplitPane'
import { paneBotVisits, installMouseHistoryButtons } from './botVisitHistory'

/** SPLIT-PANE-BOT-VISITS (2026-11-25): a mouse button acts on the pane under it. */
function paneUnderPointer(event: MouseEvent): PaneId | undefined {
    const target = event.target
    if (!(target instanceof Element)) return undefined
    const root = target.closest('[data-chat-pane], [data-pane-panel], [data-pane-rail]')
    const pane = root?.getAttribute('data-chat-pane') ?? root?.getAttribute('data-pane-panel') ?? root?.getAttribute('data-pane-rail')
    return pane === 'main' || pane === 'side' ? pane : undefined
}

export function stepBotVisit(direction: -1 | 1, event: MouseEvent): void {
    const split = get(splitChatOpen) && !isEmbeddedRisuPane && !get(MobileGUI)
    const pane = split ? paneUnderPointer(event) ?? paneState.active : 'main'
    if (paneState.active !== pane) activatePane(pane)
    const db = getDatabase()
    // Settings and a pane's Home cover its bot: back opens that visit again.
    const currentId = get(settingsOpen) || (split && paneState.home[pane]) ? undefined : db.characters[get(selectedCharID)]?.chaId
    paneBotVisits(pane).step(direction, currentId, (characterId) => {
        const index = db.characters.findIndex((character) => character?.chaId === characterId && !character.trashTime)
        if (index < 0) return false
        settingsOpen.set(false)
        changeChar(index)
        return true
    })
}

/** The mouse's back and forward buttons step through the bots opened (botVisitHistory.ts). */
export function initBotVisitButtons() {
    installMouseHistoryButtons(window, stepBotVisit)
}
