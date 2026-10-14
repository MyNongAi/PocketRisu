// Tells the laptop server someone is using the app while they only read or
// type (POST /api/laptop/use). With the desktop asleep, the laptop's remote
// switch puts it to sleep after 10 min without a request, and reading a
// long reply or writing a long input on the phone sends none: the laptop
// went to sleep under the reader (the user's report, 2026-10-14).
//
// A beat goes out at most every 3 min, only while the page is on screen and
// was touched, clicked, wheeled or typed into since the last one, so an open
// tab nobody touches never keeps the laptop up.

const BEAT_INTERVAL_MS = 3 * 60_000
const INPUT_EVENTS = ['pointerdown', 'touchstart', 'keydown', 'wheel'] as const

export interface LaptopUseBeatDeps {
    now?: () => number
    visible?: () => boolean
    send?: () => void
    target?: Pick<EventTarget, 'addEventListener'>
}

let started = false

/** Starts listening; later calls do nothing. Returns the input handler (tests). */
export function startLaptopUseBeat(deps: LaptopUseBeatDeps = {}): (() => void) | null {
    if (started || typeof window === 'undefined') return null
    started = true
    const now = deps.now ?? (() => Date.now())
    const visible = deps.visible ?? (() => document.visibilityState === 'visible')
    const send = deps.send ?? (() => {
        void fetch('/api/laptop/use', { method: 'POST', keepalive: true }).catch(() => {})
    })
    // Opening the page was a request of its own.
    let lastBeatAt = now()
    const onInput = () => {
        const at = now()
        if (!visible() || at - lastBeatAt < BEAT_INTERVAL_MS) return
        lastBeatAt = at
        send()
    }
    const target = deps.target ?? window
    for (const type of INPUT_EVENTS) target.addEventListener(type, onInput, { capture: true, passive: true })
    return onInput
}

/** Tests only. */
export function resetLaptopUseBeatForTests(): void {
    started = false
}
