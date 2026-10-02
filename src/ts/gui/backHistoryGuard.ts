// Makes the mobile Back button close the topmost open layer instead of
// leaving the page. While any layer is open exactly one same-URL history
// entry (the guard) sits on top of the page's own entry. Back pops it; the
// popstate closes the top layer and, if layers remain, steps forward onto
// the same guard entry again. Once nothing is open the guard is removed, so
// Back behaves as it always did and history is not padded with entries.
//
// Chromium marks entries pushed without a fresh user activation as skippable
// ("history manipulation intervention"): Back would then jump over the page's
// entry and leave the app. So the guard is only pushed right after a real
// touch/key, and re-entered with history.forward() rather than pushed again.

export const BACK_GUARD_STATE_KEY = '__pocketRisuBackGuard'

/** How long a forward() restore may take before the guard is pushed anew. */
export const BACK_GUARD_RESTORE_TIMEOUT_MS = 1000
/** Chromium's transient activation lifetime, for browsers without navigator.userActivation. */
const TRANSIENT_ACTIVATION_MS = 5000

const ACTIVATION_EVENTS = ['pointerup', 'touchend', 'keydown'] as const

type HistoryLike = Pick<History, 'state' | 'pushState' | 'back' | 'forward'>
type EventTargetLike = Pick<Window, 'addEventListener' | 'removeEventListener'>

export interface BackHistoryGuardOptions {
    history: HistoryLike
    target: EventTargetLike
    /** Unique per page load: history.state survives reloads. */
    guardId: string
    hasOpenLayer: () => boolean
    /** Closes (or refuses to close) the topmost layer. */
    dismissTopLayer: () => void
    /** Resolves once UI updates caused by a close have been applied. */
    settle: () => Promise<void>
    /** navigator.userActivation.isActive, or undefined where unsupported. */
    isUserActive?: () => boolean | undefined
    now?: () => number
    setTimer?: (callback: () => void, ms: number) => unknown
    clearTimer?: (handle: unknown) => void
}

function isGuardState(state: unknown, guardId: string): boolean {
    return typeof state === 'object'
        && state !== null
        && (state as Record<string, unknown>)[BACK_GUARD_STATE_KEY] === guardId
}

export function createBackHistoryGuard(options: BackHistoryGuardOptions) {
    const {
        history,
        target,
        guardId,
        hasOpenLayer,
        dismissTopLayer,
        settle,
        isUserActive = () => undefined,
        now = () => Date.now(),
        setTimer = (callback, ms) => setTimeout(callback, ms),
        clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    } = options

    // True while the current history entry is our guard.
    let armed = false
    // A traversal we started (or a close we are waiting on) is in flight.
    let pending: 'cleanup' | 'restore' | 'closing' | null = null
    let syncQueued = false
    let restoreTimer: unknown = null
    let lastActivationAt = -Infinity
    let destroyed = false

    const canArm = () => isUserActive() ?? (now() - lastActivationAt <= TRANSIENT_ACTIVATION_MS)

    const arm = () => {
        const base = typeof history.state === 'object' && history.state !== null
            ? history.state as Record<string, unknown>
            : {}
        try {
            history.pushState({ ...base, [BACK_GUARD_STATE_KEY]: guardId }, '')
            armed = true
        }
        catch (error) {
            console.warn('[backHistoryGuard] could not push the guard entry', error)
        }
    }

    const sync = () => {
        syncQueued = false
        if (destroyed || pending) return
        if (hasOpenLayer()) {
            if (!armed && canArm()) arm()
            return
        }
        if (!armed) return
        if (isGuardState(history.state, guardId)) {
            // Nothing open any more: step back off the guard onto the page's
            // own entry, which sits right behind it.
            pending = 'cleanup'
            history.back()
        }
        else {
            // Someone pushed over the guard; leave their entry alone.
            armed = false
        }
    }

    const requestSync = () => {
        if (syncQueued || destroyed) return
        syncQueued = true
        void settle().then(sync)
    }

    const clearRestoreTimer = () => {
        if (restoreTimer === null) return
        clearTimer(restoreTimer)
        restoreTimer = null
    }

    const finishBack = () => {
        pending = null
        if (destroyed || !hasOpenLayer()) return
        // Layers remain: re-enter the guard entry Back just left.
        pending = 'restore'
        history.forward()
        restoreTimer = setTimer(() => {
            restoreTimer = null
            if (pending !== 'restore') return
            pending = null
            requestSync()
        }, BACK_GUARD_RESTORE_TIMEOUT_MS)
    }

    const onPopState = () => {
        if (destroyed) return
        const wasArmed = armed
        armed = isGuardState(history.state, guardId)

        if (pending === 'cleanup' || pending === 'restore') {
            pending = null
            clearRestoreTimer()
            requestSync()
            return
        }
        // A second traversal while a close settles; finishBack resyncs.
        if (pending === 'closing') return
        // Not our entry being left (or a Forward onto the guard): today's behaviour.
        if (!wasArmed || armed) {
            requestSync()
            return
        }

        // Back left the guard: close the top layer instead of navigating.
        pending = 'closing'
        try {
            dismissTopLayer()
        }
        catch (error) {
            console.error('[backHistoryGuard] closing the top layer failed', error)
        }
        void settle().then(finishBack, finishBack)
    }

    const onActivation = (event: Event) => {
        if (!event.isTrusted) return
        lastActivationAt = now()
        // A layer opened without a gesture (an error alert, say) gets its
        // guard on the next real touch.
        if (!armed && !pending && hasOpenLayer()) requestSync()
    }

    target.addEventListener('popstate', onPopState)
    for (const type of ACTIVATION_EVENTS) {
        target.addEventListener(type, onActivation, { capture: true, passive: true })
    }

    return {
        /** Re-evaluate after layers opened or closed. */
        requestSync,
        destroy() {
            destroyed = true
            clearRestoreTimer()
            target.removeEventListener('popstate', onPopState)
            for (const type of ACTIVATION_EVENTS) {
                target.removeEventListener(type, onActivation, { capture: true })
            }
        },
    }
}
