// The bots opened in this session, in order, so a mouse's back and forward
// buttons step through them like pages (the user's request, 2026-10-30:
// "방금 본 봇을 앞으로 가든 뒤로 가든"). Browsers turn those buttons into page
// history steps, which here left the app; they are taken over instead.

const MAX_VISITS = 50

/** Mouse buttons 3 and 4: back and forward (MouseEvent.button). */
const STEP_BY_BUTTON: Record<number, -1 | 1> = { 3: -1, 4: 1 }

export interface BotVisitHistory {
    /** A bot was opened; a new one drops the visits ahead, as a page does. */
    record(characterId: string | undefined): void
    /**
     * Open the visit one step back or forward that can still be opened, and
     * say whether one was. Back from a screen that is not the current visit
     * (home, settings) opens that visit itself.
     */
    step(direction: -1 | 1, currentId: string | undefined, open: (characterId: string) => boolean): boolean
    readonly visits: readonly string[]
    readonly at: number
}

export function createBotVisitHistory(max = MAX_VISITS): BotVisitHistory {
    const visits: string[] = []
    let at = -1
    let stepping = false
    return {
        record(characterId) {
            if (!characterId || stepping || visits[at] === characterId) return
            visits.splice(at + 1)
            visits.push(characterId)
            if (visits.length > max) visits.splice(0, visits.length - max)
            at = visits.length - 1
        },
        step(direction, currentId, open) {
            let next = direction < 0 && currentId !== visits[at] ? at : at + direction
            for (; next >= 0 && next < visits.length; next += direction) {
                stepping = true
                let opened = false
                try {
                    opened = visits[next] !== currentId && open(visits[next])
                } finally {
                    stepping = false
                }
                if (opened) {
                    at = next
                    return true
                }
            }
            return false
        },
        get visits() { return visits },
        get at() { return at },
    }
}

/**
 * Take the mouse's back and forward buttons over: the step runs on release,
 * and the browser's own page step is held back on press and release alike.
 */
export function installMouseHistoryButtons(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, onStep: (direction: -1 | 1) => void): () => void {
    const hold = (event: Event) => {
        const direction = STEP_BY_BUTTON[(event as MouseEvent).button]
        if (!direction) return
        event.preventDefault()
        event.stopPropagation()
        if (event.type === 'mouseup') onStep(direction)
    }
    const types = ['mousedown', 'mouseup', 'auxclick'] as const
    for (const type of types) target.addEventListener(type, hold, true)
    return () => {
        for (const type of types) target.removeEventListener(type, hold, true)
    }
}

export const botVisits = createBotVisitHistory()
