import { describe, expect, test } from 'vitest'
import { flushSync } from 'svelte'
import {
    mergeTrackedModuleChanges,
    trackModuleTreeChanges,
    type ModuleTreeChange,
} from './moduleChangeTracker.svelte'

function setup(initial: any[]) {
    const state = $state({ modules: initial })
    const changes: ModuleTreeChange[] = []
    const stop = $effect.root(() => {
        trackModuleTreeChanges(() => state.modules, change => changes.push(change))
    })
    flushSync()
    return { state, changes, stop }
}

describe('trackModuleTreeChanges', () => {
    test('does not report the initial subscription as a change', () => {
        const { changes, stop } = setup([{ id: 'a', nested: { text: 'x' } }])
        expect(changes).toEqual([])
        stop()
    })

    test('reports only the deeply edited module', () => {
        const { state, changes, stop } = setup([
            { id: 'a', nested: { text: 'x' } },
            { id: 'b', nested: { text: 'y' } },
            { id: 'c', nested: { text: 'z' } },
        ])
        state.modules[1].nested.text = 'changed'
        flushSync()
        expect(changes).toEqual([{ kind: 'content', moduleId: 'b' }])
        stop()
    })

    test('a deep edit does not re-walk the other modules', () => {
        const count = 120
        const reads = Array.from({ length: count }, () => 0)
        const modules = Array.from({ length: count }, (_, i) => {
            const module: any = { id: `m${i}`, nested: { text: `value-${i}` } }
            Object.defineProperty(module, 'observedPayload', {
                enumerable: true,
                get() {
                    reads[i] += 1
                    return { value: i }
                },
            })
            return module
        })
        const { state, changes, stop } = setup(modules)
        reads.fill(0)

        const editedIndex = 73
        state.modules[editedIndex].nested.text = 'changed'
        flushSync()

        expect(changes).toEqual([{ kind: 'content', moduleId: `m${editedIndex}` }])
        expect(reads[editedIndex]).toBeGreaterThan(0)
        expect(reads.reduce((sum, value, i) => i === editedIndex ? sum : sum + value, 0)).toBe(0)
        stop()
    })

    test('tracks deep array push, key add and key delete inside one module', () => {
        const { state, changes, stop } = setup([
            { id: 'a', lorebook: [{ content: 'x' }], extra: { old: true } },
        ])
        state.modules[0].lorebook.push({ content: 'y' })
        flushSync()
        ;(state.modules[0].extra as any).added = 1
        flushSync()
        delete state.modules[0].extra.old
        flushSync()
        expect(changes).toEqual([
            { kind: 'content', moduleId: 'a' },
            { kind: 'content', moduleId: 'a' },
            { kind: 'content', moduleId: 'a' },
        ])
        stop()
    })

    test.each([
        ['push', (s: any) => s.modules.push({ id: 'c', value: 3 })],
        ['remove', (s: any) => s.modules.splice(0, 1)],
        ['reorder', (s: any) => s.modules.reverse()],
        ['slot replacement with a different id', (s: any) => { s.modules[0] = { id: 'different', value: 99 } }],
    ])('reports %s as a structural change', (_name, mutate) => {
        const { state, changes, stop } = setup([
            { id: 'a', value: 1 },
            { id: 'b', value: 2 },
        ])
        mutate(state)
        flushSync()
        expect(changes).toEqual([{ kind: 'structure' }])
        stop()
    })

    test('same-id slot replacement is reported as content-only', () => {
        const { state, changes, stop } = setup([
            { id: 'a', value: 1 },
            { id: 'b', value: 2 },
        ])
        state.modules[0] = { id: 'a', value: 99 }
        flushSync()
        expect(changes).toEqual([{ kind: 'content', moduleId: 'a', replaced: true }])
        stop()
    })

    test('in-place namespace edit requests module routing cache refresh', () => {
        const { state, changes, stop } = setup([
            { id: 'a', namespace: 'old', value: 1 },
            { id: 'b', value: 2 },
        ])
        state.modules[0].namespace = 'new'
        flushSync()
        expect(changes).toContainEqual({
            kind: 'content',
            moduleId: 'a',
            routingChanged: true,
        })
        stop()
    })

    test('removed module child effect is cleaned up', () => {
        const { state, changes, stop } = setup([
            { id: 'removed', nested: { value: 1 } },
            { id: 'kept', nested: { value: 2 } },
        ])
        const removed = state.modules[0]
        state.modules.splice(0, 1)
        flushSync()
        expect(changes).toEqual([{ kind: 'structure' }])
        changes.length = 0

        // The old child effect must have been destroyed with its parent. If it
        // leaked, this detached object edit would be reported and retained.
        removed.nested.value = 99
        flushSync()
        expect(changes).toEqual([])
        stop()
    })

    test('replacing only the array wrapper with identical items is not dirty', () => {
        const { state, changes, stop } = setup([
            { id: 'a', value: 1 },
            { id: 'b', value: 2 },
        ])
        state.modules = [...state.modules]
        flushSync()
        expect(changes).toEqual([])
        stop()
    })

    test('uses a conservative null hint for an invalid module id', () => {
        const { state, changes, stop } = setup([{ id: 1, value: 'x' }])
        state.modules[0].value = 'y'
        flushSync()
        expect(changes).toEqual([{ kind: 'content', moduleId: null }])
        stop()
    })
})

describe('mergeTrackedModuleChanges', () => {
    test('keeps unrelated newer server modules while applying the dirty local module', () => {
        const latest = [
            { id: 'a', value: 'remote-new' },
            { id: 'b', value: 'remote-old' },
        ]
        const local = [
            { id: 'a', value: 'local-old' },
            { id: 'b', value: 'local-edit' },
        ]
        expect(mergeTrackedModuleChanges(latest, local, ['b'])).toEqual([
            { id: 'a', value: 'remote-new' },
            { id: 'b', value: 'local-edit' },
        ])
    })

    test('supports a hinted add and delete without touching unrelated modules', () => {
        expect(mergeTrackedModuleChanges(
            [{ id: 'a' }, { id: 'deleted' }],
            [{ id: 'a' }, { id: 'added' }],
            ['deleted', 'added'],
        )).toEqual([{ id: 'a' }, { id: 'added' }])
    })

    test.each([null, undefined])('uses conservative local-wins merge for %s hint', hint => {
        const local = [{ id: 'local', value: 1 }]
        expect(mergeTrackedModuleChanges([{ id: 'remote', value: 2 }], local, hint)).toBe(local)
    })

    test('unsafe ids fall back to the complete local array without dropping data', () => {
        const local = [{ id: 'same', value: 1 }, { id: 'same', value: 2 }]
        expect(mergeTrackedModuleChanges([{ id: 'same', value: 0 }], local, ['same'])).toBe(local)
    })
})
