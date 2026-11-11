import type { PaneId } from '../chatPanes.svelte'

const KEY = 'pocketrisu:rail-bot-list'

function read(): Record<PaneId, boolean> {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null')
        return { main: saved?.main !== false, side: saved?.side !== false }
    } catch {
        return { main: true, side: true }
    }
}

// Rail visibility belongs to this browser and pane, not to a character or chat.
export const railBotListShown = $state<Record<PaneId, boolean>>(read())

export function setRailBotListShown(pane: PaneId, shown: boolean): void {
    railBotListShown[pane] = shown
    try {
        localStorage.setItem(KEY, JSON.stringify(railBotListShown))
    } catch {
        // A private browser can still use the toggle for this session.
    }
}
