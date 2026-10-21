import { describe, expect, test } from 'vitest'
import { flushSync } from 'svelte'
import { trackModuleTreeChanges } from './moduleChangeTracker.svelte'

// What a stored-module landing does to the live modules (applyRemoteChangesInPlace):
// the body fields deleted and the marker added, in place, for many at once.
function store(module: any) {
    delete module.lorebook
    delete module.regex
    module.nodeOnlyColdModule = { archivedAt: 1, bytes: 1 }
}

function setup(count: number, onChange: () => void) {
    const state = $state({
        modules: Array.from({ length: count }, (_, i) => ({ id: `m${i}`, lorebook: [{ key: `k${i}` }], regex: [] })) as any[],
    })
    const stop = $effect.root(() => {
        trackModuleTreeChanges(() => state.modules, onChange)
    })
    flushSync()
    return { state, stop }
}

describe('module tree changes landing at once', () => {
    for (const count of [1, 3, 100, 300]) {
        test(`${count} module(s) changed in one step settle`, () => {
            // The save loop's callback bumps a shared revision (globalApi.svelte.ts).
            const revision = $state({ value: 0 })
            let calls = 0
            const { state, stop } = setup(count, () => {
                calls++
                revision.value += 1
            })
            for (const module of state.modules) store(module)
            expect(() => flushSync()).not.toThrow()
            expect(calls).toBe(count)
            stop()
        })
    }
})
