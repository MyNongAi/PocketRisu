// Layers the mobile Back button closes before it may leave the page: alert
// dialogs, popups, the settings page and overlay side panels. Each open layer
// registers itself here; src/ts/gui/mobileBackNavigation.svelte.ts closes the
// topmost one when Back is pressed (see backHistoryGuard.ts).

/** Higher ranks close first; layers of one rank close newest first. */
export const BackLayerRank = {
    /** Overlay sidebar and the mobile GUI's side panels. */
    Panel: 0,
    /** The settings page. */
    Page: 100,
    /** Lists, pickers, managers and editors drawn over the app. */
    Popup: 200,
    /** Modal dialogs (ShDialog). */
    Dialog: 300,
    /** Floating context menus (popupStore). */
    Menu: 350,
    /** alertStore dialogs and blocking loading/safety modals. */
    Alert: 400,
} as const

export interface BackLayer {
    rank: number
    /**
     * Closes the layer the way its own cancel/close control does. Returning
     * false, or leaving it out, makes the layer non-dismissable: Back is then
     * swallowed and the layer stays.
     */
    close?: () => boolean | void
}

export type BackDismissResult = 'closed' | 'blocked' | 'none'

type Entry = BackLayer & { seq: number }

export function createBackLayerStack() {
    const entries: Entry[] = []
    const listeners = new Set<() => void>()
    let seq = 0

    const notify = () => {
        for (const listener of listeners) listener()
    }

    const top = (): Entry | undefined => {
        let best: Entry | undefined
        for (const entry of entries) {
            if (!best || entry.rank > best.rank || (entry.rank === best.rank && entry.seq > best.seq)) {
                best = entry
            }
        }
        return best
    }

    return {
        /** Adds an open layer; the returned function removes it (idempotent). */
        register(layer: BackLayer): () => void {
            const entry: Entry = { ...layer, seq: ++seq }
            entries.push(entry)
            notify()
            return () => {
                const index = entries.indexOf(entry)
                if (index < 0) return
                entries.splice(index, 1)
                notify()
            }
        },
        hasOpen(): boolean {
            return entries.length > 0
        },
        /** Closes the topmost layer, unless it refuses to be dismissed. */
        dismissTop(): BackDismissResult {
            const entry = top()
            if (!entry) return 'none'
            if (!entry.close) return 'blocked'
            return entry.close() === false ? 'blocked' : 'closed'
        },
        /** Called after every register/unregister. */
        subscribe(listener: () => void): () => void {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
        },
    }
}

export type BackLayerStack = ReturnType<typeof createBackLayerStack>

export const backLayers = createBackLayerStack()

/**
 * Registers a layer for as long as `isOpen()` is true. Call during component
 * initialisation (or inside $effect.root); `close` is read when Back is pressed.
 */
export function useBackLayer(
    rank: number,
    isOpen: () => boolean,
    close?: () => boolean | void,
    stack: BackLayerStack = backLayers,
): void {
    const open = $derived(isOpen())
    $effect(() => {
        if (!open) return
        return stack.register({ rank, close })
    })
}

type AlertLike = { type: string, msg?: string }

/**
 * The alertStore value Back leaves behind for an open alert: the same answer
 * its cancel / "no" / close control gives, never an acceptance. null when the
 * alert offers no such control (pickers, loading, login); Back then waits.
 */
export function alertBackDismissal(alert: AlertLike): { type: 'none', msg: string } | null {
    switch (alert.type) {
        case 'ask':
        case 'pluginconfirm':
        case 'tos':
            return { type: 'none', msg: 'no' }
        case 'confirmMulti':
        case 'addchar':
            return { type: 'none', msg: 'cancel' }
        case 'cardexport':
            return { type: 'none', msg: JSON.stringify({ type: 'cancel', type2: '' }) }
        // Their cancel/close buttons all answer with an empty string.
        case 'input':
        case 'error':
        case 'normal':
        case 'markdown':
        case 'requestdata':
        case 'branches':
        case 'selectModule':
            return { type: 'none', msg: '' }
        default:
            // 'select' (any index would pick an option), 'selectChar', 'login',
            // 'wait', 'wait2', 'progress' and anything unknown.
            return null
    }
}
