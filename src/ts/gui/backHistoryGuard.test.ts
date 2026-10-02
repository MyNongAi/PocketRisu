import { afterEach, describe, expect, test } from 'vitest'
import { BACK_GUARD_STATE_KEY, BACK_GUARD_RESTORE_TIMEOUT_MS, createBackHistoryGuard } from './backHistoryGuard'
import { createBackLayerStack } from './backLayers.svelte'

// A small model of a tab's session history. Entry 0 is another site: a
// traversal onto it means Back left the app. The page's own entry is 1.
// back()/forward() are asynchronous like in browsers; the user's Back button
// (pressBack) traverses at once.
function createBrowser(initialState: unknown = null) {
    const entries: { state: unknown, outside?: boolean }[] = [
        { state: null, outside: true },
        { state: initialState },
    ]
    let index = 1
    let left = false
    let forwardWorks = true
    const queue: (() => void)[] = []
    const listeners = new Map<string, Set<(event: any) => void>>()

    const go = (delta: number) => {
        const next = index + delta
        if (next < 0 || next >= entries.length) return
        index = next
        if (entries[index].outside) {
            left = true
            return
        }
        for (const listener of listeners.get('popstate') ?? []) listener({ type: 'popstate', state: entries[index].state })
    }

    const history = {
        get state() { return entries[index].state },
        pushState(state: unknown) {
            entries.splice(index + 1)
            entries.push({ state: structuredClone(state) })
            index++
        },
        back() { queue.push(() => go(-1)) },
        forward() { if (forwardWorks) queue.push(() => go(1)) },
    }
    const target = {
        addEventListener(type: string, listener: (event: any) => void) {
            const set = listeners.get(type) ?? new Set()
            set.add(listener)
            listeners.set(type, set)
        },
        removeEventListener(type: string, listener: (event: any) => void) {
            listeners.get(type)?.delete(listener)
        },
    }

    return {
        history,
        target,
        get index() { return index },
        get length() { return entries.length },
        get left() { return left },
        get onGuard() {
            const state = entries[index].state as Record<string, unknown> | null
            return typeof state === 'object' && state !== null && BACK_GUARD_STATE_KEY in state
        },
        breakForward() { forwardWorks = false },
        pressBack() { go(-1) },
        dispatch(type: string) {
            for (const listener of listeners.get(type) ?? []) listener({ type, isTrusted: true })
        },
        listenerCount() {
            let count = 0
            for (const set of listeners.values()) count += set.size
            return count
        },
        runTraversals() {
            while (queue.length > 0) queue.shift()!()
        },
    }
}

type Browser = ReturnType<typeof createBrowser>

function setup(options: { initialState?: unknown, userActive?: boolean | undefined } = {}) {
    const browser = createBrowser(options.initialState ?? null)
    const layers = createBackLayerStack()
    const env = {
        userActive: 'userActive' in options ? options.userActive : true,
        clock: 0,
        timers: [] as (() => void)[],
    }
    const guard = createBackHistoryGuard({
        history: browser.history,
        target: browser.target,
        guardId: 'this-page',
        hasOpenLayer: () => layers.hasOpen(),
        dismissTopLayer: () => { layers.dismissTop() },
        settle: () => Promise.resolve(),
        isUserActive: () => env.userActive,
        now: () => env.clock,
        setTimer: (callback) => { env.timers.push(callback); return callback },
        clearTimer: (handle) => { env.timers = env.timers.filter((timer) => timer !== handle) },
    })
    layers.subscribe(guard.requestSync)

    const open = (options: { blocking?: boolean } = {}) => {
        const layer = {
            isOpen: true,
            unregister: () => {},
            closeFromUi() {
                layer.isOpen = false
                layer.unregister()
            },
        }
        layer.unregister = layers.register({
            rank: 0,
            close: options.blocking ? undefined : () => layer.closeFromUi(),
        })
        return layer
    }

    return { browser, layers, guard, env, open }
}

// Let microtasks (settle) and queued history traversals run to a standstill.
async function idle(browser: Browser) {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve()
        browser.runTraversals()
    }
}

let current: ReturnType<typeof setup> | null = null
afterEach(() => {
    current?.guard.destroy()
    current = null
})

describe('mobile Back history guard', () => {
    test('one guard entry, however many layers open', async () => {
        const t = current = setup()
        t.open()
        await idle(t.browser)
        expect(t.browser.onGuard).toBe(true)
        expect(t.browser.length).toBe(3)

        t.open()
        t.open()
        await idle(t.browser)
        expect(t.browser.length).toBe(3)
        expect(t.browser.index).toBe(2)
    })

    test('Back closes the top layer and stays on the guard while layers remain', async () => {
        const t = current = setup()
        const bottom = t.open()
        const top = t.open()
        await idle(t.browser)

        t.browser.pressBack()
        await idle(t.browser)
        expect(top.isOpen).toBe(false)
        expect(bottom.isOpen).toBe(true)
        expect(t.browser.onGuard).toBe(true)
        expect(t.browser.length).toBe(3)

        t.browser.pressBack()
        await idle(t.browser)
        expect(bottom.isOpen).toBe(false)
        // Nothing open: back on the page's own entry, nothing pushed.
        expect(t.browser.index).toBe(1)
        expect(t.browser.onGuard).toBe(false)
        expect(t.browser.left).toBe(false)

        // Then Back behaves as before.
        t.browser.pressBack()
        expect(t.browser.left).toBe(true)
    })

    test('closing the last layer from its own button removes the guard', async () => {
        const t = current = setup()
        const layer = t.open()
        await idle(t.browser)
        expect(t.browser.index).toBe(2)

        layer.closeFromUi()
        await idle(t.browser)
        expect(t.browser.index).toBe(1)
        expect(t.browser.onGuard).toBe(false)

        t.browser.pressBack()
        expect(t.browser.left).toBe(true)
    })

    test('history does not grow over repeated open/close cycles', async () => {
        const t = current = setup()
        for (let cycle = 0; cycle < 5; cycle++) {
            t.open()
            t.open()
            await idle(t.browser)
            t.browser.pressBack()
            await idle(t.browser)
            t.browser.pressBack()
            await idle(t.browser)
            t.open().closeFromUi()
            await idle(t.browser)
            expect(t.browser.length).toBeLessThanOrEqual(3)
            expect(t.browser.index).toBe(1)
        }
        expect(t.browser.left).toBe(false)
    })

    test('a layer that refuses dismissal swallows Back without leaving', async () => {
        const t = current = setup()
        t.open({ blocking: true })
        await idle(t.browser)

        for (let press = 0; press < 3; press++) {
            t.browser.pressBack()
            await idle(t.browser)
            expect(t.layers.hasOpen()).toBe(true)
            expect(t.browser.onGuard).toBe(true)
        }
        expect(t.browser.length).toBe(3)
        expect(t.browser.left).toBe(false)
    })

    test('no guard without a user activation; the next real touch arms it', async () => {
        const t = current = setup({ userActive: false })
        t.open()
        await idle(t.browser)
        expect(t.browser.length).toBe(2)

        // Back before any touch: today's behaviour.
        t.browser.pressBack()
        expect(t.browser.left).toBe(true)
    })

    test('a layer opened without a gesture gets its guard on the next touch', async () => {
        const t = current = setup({ userActive: false })
        t.open()
        await idle(t.browser)
        expect(t.browser.length).toBe(2)

        t.env.userActive = true
        t.browser.dispatch('touchend')
        await idle(t.browser)
        expect(t.browser.onGuard).toBe(true)
    })

    test('without navigator.userActivation a recent touch counts as activation', async () => {
        const t = current = setup({ userActive: undefined })
        t.env.clock = 10_000
        t.open()
        await idle(t.browser)
        expect(t.browser.length).toBe(2)

        t.browser.dispatch('pointerup')
        await idle(t.browser)
        expect(t.browser.onGuard).toBe(true)

        t.browser.pressBack()
        await idle(t.browser)
        t.env.clock += 60_000
        // Long after the touch: a new layer waits for the next one.
        t.open()
        await idle(t.browser)
        expect(t.browser.index).toBe(1)
    })

    test('a layer opened while the guard is being removed gets a guard again', async () => {
        const t = current = setup()
        const first = t.open()
        await idle(t.browser)

        first.closeFromUi()
        // The cleanup back() is still queued when the next layer opens.
        await Promise.resolve()
        await Promise.resolve()
        const second = t.open()
        await idle(t.browser)
        expect(t.browser.onGuard).toBe(true)
        expect(t.browser.length).toBe(3)

        t.browser.pressBack()
        await idle(t.browser)
        expect(second.isOpen).toBe(false)
        expect(t.browser.index).toBe(1)
    })

    test('a restore that never lands pushes the guard again after the timeout', async () => {
        const t = current = setup()
        t.open()
        const top = t.open()
        await idle(t.browser)

        t.browser.breakForward()
        t.browser.pressBack()
        await idle(t.browser)
        expect(top.isOpen).toBe(false)
        expect(t.browser.index).toBe(1)
        expect(t.env.timers).toHaveLength(1)
        expect(BACK_GUARD_RESTORE_TIMEOUT_MS).toBeGreaterThan(0)

        t.env.timers.shift()!()
        await idle(t.browser)
        expect(t.browser.onGuard).toBe(true)
        expect(t.browser.length).toBe(3)
    })

    test('keeps the page state and ignores a guard marker left by an earlier load', async () => {
        const stale = { route: 'chat', [BACK_GUARD_STATE_KEY]: 'previous-load' }
        const t = current = setup({ initialState: stale })
        const layer = t.open()
        await idle(t.browser)
        expect(t.browser.history.state).toEqual({ route: 'chat', [BACK_GUARD_STATE_KEY]: 'this-page' })

        t.browser.pressBack()
        await idle(t.browser)
        expect(layer.isOpen).toBe(false)
        expect(t.browser.history.state).toEqual(stale)
        expect(t.browser.left).toBe(false)
    })

    test('a traversal between foreign entries is left alone', async () => {
        const t = current = setup()
        // The app pushed its own entry (e.g. a Realm link) before any layer.
        t.browser.history.pushState({ realm: true })
        t.browser.pressBack()
        await idle(t.browser)
        expect(t.browser.index).toBe(1)
        expect(t.browser.length).toBe(3)
        expect(t.browser.left).toBe(false)
    })

    test('destroy detaches every listener', () => {
        const t = setup()
        expect(t.browser.listenerCount()).toBeGreaterThan(0)
        t.guard.destroy()
        expect(t.browser.listenerCount()).toBe(0)
    })
})
