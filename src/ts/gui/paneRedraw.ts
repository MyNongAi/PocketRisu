// SPLIT-PANE-ISOLATION (2026-11-25)
import type { PaneId } from '../chatPanes.svelte'

export function paneMayRedraw(active: boolean, chatId: string | undefined, selectedChatId: string | undefined): boolean {
    return active || !!chatId && chatId === selectedChatId
}

/** Each mounted body keeps its own effective redraw revision. */
export class PaneRedrawGate {
    revision = 0
    missed = false

    signal(allowed: boolean): boolean {
        if (!allowed) {
            this.missed = true
            return false
        }
        this.missed = false
        this.revision++
        return true
    }

    catchUp(allowed: boolean): boolean {
        return this.missed && this.signal(allowed)
    }
}

export function roomChanged(previous: string | null, current: string | null): boolean {
    return current !== null && previous !== current
}

export type PaneScrollRequest = { pane: PaneId, chatId: string, index: number, serial: number }

export function matchesScrollRequest(request: PaneScrollRequest | null, pane: PaneId, chatId: string | undefined, serial: number): boolean {
    return !!request && request.pane === pane && request.chatId === chatId && request.serial === serial
}
