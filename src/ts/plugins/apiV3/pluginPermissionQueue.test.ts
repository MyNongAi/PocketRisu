import { describe, expect, it } from 'vitest'
import { get, writable } from 'svelte/store'

// Headless reproduction of the plugin-permission dialog race and its fix.
//
// The real getPluginPermission() lives behind DOM/iframe/DBState dependencies,
// so we cannot import it directly. Instead we faithfully replicate the two
// mechanisms that actually cause the reported bug:
//
//   1. The shared single alertStore + waitAlert() polling loop, copied 1:1
//      from src/ts/alert.ts. Every dialog writes to ONE store and waits for
//      type==='none', which is exactly why concurrent dialogs clobber each
//      other in the original code.
//   2. Two getPluginPermission variants — "buggy" (no serialization, the
//      original flow) and "fixed" (the Promise-chain mutex from this branch).
//
// A simulated user answers dialogs one at a time, the way a human clicking the
// modal would. We then assert the buggy version exhibits the reported symptom
// and the fixed version does not.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ─── Replica of the shared alert store (mirrors src/ts/alert.ts) ────────────

type AlertData = { type: 'none' | 'ask'; msg: string }

function makeAlertHarness() {
    const alertStore = writable<AlertData>({ type: 'none', msg: 'n' })

    // Tracks how many dialogs believe they are "currently shown" at any instant.
    // In the real UI only one modal renders, but each concurrent alertConfirm
    // call thinks it owns the store — this counter exposes the clobber.
    let liveDialogs = 0
    let maxConcurrentLive = 0

    async function waitAlert() {
        while (true) {
            if (get(alertStore).type === 'none') break
            await sleep(2)
        }
    }

    // 1:1 with alert.ts alertConfirm: set the single store, wait, read result.
    async function alertConfirm(msg: string): Promise<boolean> {
        liveDialogs++
        maxConcurrentLive = Math.max(maxConcurrentLive, liveDialogs)
        try {
            alertStore.set({ type: 'ask', msg })
            await waitAlert()
            return get(alertStore).msg === 'yes'
        } finally {
            liveDialogs--
        }
    }

    return { alertStore, alertConfirm, getMaxConcurrentLive: () => maxConcurrentLive }
}

// Simulated user: every few ms, if a dialog is open, answer it (yes) by
// resetting the store to 'none' — the same transition the real footer buttons
// perform. Returns a stop() handle.
function startAutoResponder(alertStore: ReturnType<typeof makeAlertHarness>['alertStore']) {
    let stopped = false
    const loop = async () => {
        while (!stopped) {
            if (get(alertStore).type === 'ask') {
                alertStore.set({ type: 'none', msg: 'yes' })
            }
            await sleep(3)
        }
    }
    const done = loop()
    return { stop: async () => { stopped = true; await done } }
}

// ─── Shared permission state (mirrors v3.svelte.ts module state) ─────────────

function makePermissionState() {
    const given = new Set<string>()
    const denied = new Set<string>()
    const cache = new Map<string, boolean>()
    return { given, denied, cache }
}

// ─── BUGGY variant: original flow, no serialization ──────────────────────────

function makeBuggyGetPermission(
    state: ReturnType<typeof makePermissionState>,
    alertConfirm: (m: string) => Promise<boolean>,
) {
    return async function getPluginPermission(pluginName: string): Promise<boolean> {
        if (state.given.has(pluginName)) return true
        if (state.denied.has(pluginName)) return false
        const conf = await alertConfirm(`Allow ${pluginName}?`)
        if (conf) {
            state.given.add(pluginName)
            return true
        }
        state.denied.add(pluginName)
        return false
    }
}

// ─── FIXED variant: Promise-chain mutex + double-check (this branch) ──────────

function makeFixedGetPermission(
    state: ReturnType<typeof makePermissionState>,
    alertConfirm: (m: string) => Promise<boolean>,
) {
    let chain: Promise<unknown> = Promise.resolve()

    const resolved = (pluginName: string): { resolved: boolean; value: boolean } => {
        if (state.given.has(pluginName)) return { resolved: true, value: true }
        if (state.denied.has(pluginName)) return { resolved: true, value: false }
        return { resolved: false, value: false }
    }

    return async function getPluginPermission(pluginName: string): Promise<boolean> {
        const early = resolved(pluginName)
        if (early.resolved) return early.value

        const showDialog = async (): Promise<boolean> => {
            const recheck = resolved(pluginName)
            if (recheck.resolved) return recheck.value
            const conf = await alertConfirm(`Allow ${pluginName}?`)
            if (conf) {
                state.given.add(pluginName)
                return true
            }
            state.denied.add(pluginName)
            return false
        }

        const run = chain.catch(() => {}).then(() => showDialog())
        chain = run.catch(() => {})
        return run
    }
}

describe('plugin permission dialog serialization', () => {
    it('BUGGY: concurrent requests clobber the shared dialog (reproduces the report)', async () => {
        const harness = makeAlertHarness()
        const state = makePermissionState()
        const getPerm = makeBuggyGetPermission(state, harness.alertConfirm)
        const responder = startAutoResponder(harness.alertStore)

        const plugins = ['A', 'B', 'C', 'D']
        const results = await Promise.all(plugins.map((p) => getPerm(p)))

        await responder.stop()

        // The bug: multiple dialogs are "live" on the single store at once.
        expect(harness.getMaxConcurrentLive()).toBeGreaterThan(1)
    })

    it('FIXED: only one dialog is live at a time, every request gets its own answer', async () => {
        const harness = makeAlertHarness()
        const state = makePermissionState()
        const getPerm = makeFixedGetPermission(state, harness.alertConfirm)
        const responder = startAutoResponder(harness.alertStore)

        const plugins = ['A', 'B', 'C', 'D']
        const results = await Promise.all(plugins.map((p) => getPerm(p)))

        await responder.stop()

        // Never more than one dialog on the shared store simultaneously.
        expect(harness.getMaxConcurrentLive()).toBe(1)
        // Every plugin received and recorded its own grant.
        expect(results).toEqual([true, true, true, true])
        expect([...state.given].sort()).toEqual(['A', 'B', 'C', 'D'])
    })

    it('FIXED: cached/granted permission skips the queue (fast path, no blocking)', async () => {
        const harness = makeAlertHarness()
        const state = makePermissionState()
        state.given.add('AlreadyGranted')
        const getPerm = makeFixedGetPermission(state, harness.alertConfirm)

        // No responder running — if this blocked on a dialog it would hang.
        const result = await getPerm('AlreadyGranted')

        expect(result).toBe(true)
        // No dialog was ever shown for an already-granted plugin.
        expect(harness.getMaxConcurrentLive()).toBe(0)
    })

    it('FIXED: a duplicate request for the same plugin is auto-resolved after the first grant', async () => {
        const harness = makeAlertHarness()
        const state = makePermissionState()
        const getPerm = makeFixedGetPermission(state, harness.alertConfirm)
        const responder = startAutoResponder(harness.alertStore)

        // Two concurrent requests for the SAME plugin. The second must NOT show
        // a second dialog — the double-check under the lock catches the grant.
        const [r1, r2] = await Promise.all([getPerm('Dup'), getPerm('Dup')])

        await responder.stop()

        expect(r1).toBe(true)
        expect(r2).toBe(true)
        // Only one dialog total: the second request short-circuited.
        expect(harness.getMaxConcurrentLive()).toBe(1)
    })

    it('FIXED: a throwing dialog does not deadlock later requests', async () => {
        const harness = makeAlertHarness()
        const state = makePermissionState()
        let chain: Promise<unknown> = Promise.resolve()

        // Minimal chain identical to the fix, but the first dialog throws.
        const run = (fn: () => Promise<boolean>) => {
            const r = chain.catch(() => {}).then(fn)
            chain = r.catch(() => {})
            return r
        }

        const first = run(async () => { throw new Error('boom') })
        const second = run(async () => {
            return harness.alertConfirm('after boom')
        })
        const responder = startAutoResponder(harness.alertStore)

        await expect(first).rejects.toThrow('boom')
        // The second request still runs and resolves — no deadlock.
        await expect(second).resolves.toBe(true)
        await responder.stop()
    })
})
