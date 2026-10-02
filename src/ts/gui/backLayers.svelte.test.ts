import { describe, expect, test, vi } from 'vitest'
import { flushSync } from 'svelte'
import { alertBackDismissal, BackLayerRank, createBackLayerStack, useBackLayer } from './backLayers.svelte'

describe('back layer stack', () => {
    test('closes the highest rank first, newest first within a rank', () => {
        const stack = createBackLayerStack()
        const closed: string[] = []
        const add = (name: string, rank: number) => {
            const unregister = stack.register({ rank, close: () => { closed.push(name); unregister() } })
        }
        add('sidebar', BackLayerRank.Panel)
        add('persona list', BackLayerRank.Popup)
        add('settings', BackLayerRank.Page)
        add('alert', BackLayerRank.Alert)
        add('module list', BackLayerRank.Popup)

        while (stack.hasOpen()) expect(stack.dismissTop()).toBe('closed')
        expect(closed).toEqual(['alert', 'module list', 'persona list', 'settings', 'sidebar'])
        expect(stack.dismissTop()).toBe('none')
    })

    test('a layer without close, or whose close returns false, blocks', () => {
        const stack = createBackLayerStack()
        const below = vi.fn()
        stack.register({ rank: BackLayerRank.Popup, close: below })
        const loading = stack.register({ rank: BackLayerRank.Alert })
        expect(stack.dismissTop()).toBe('blocked')
        loading()

        stack.register({ rank: BackLayerRank.Dialog, close: () => false })
        expect(stack.dismissTop()).toBe('blocked')
        expect(below).not.toHaveBeenCalled()
    })

    test('unregister is idempotent and notifies subscribers once per change', () => {
        const stack = createBackLayerStack()
        const listener = vi.fn()
        stack.subscribe(listener)
        const unregister = stack.register({ rank: 0 })
        unregister()
        unregister()
        expect(listener).toHaveBeenCalledTimes(2)
        expect(stack.hasOpen()).toBe(false)
    })

    test('useBackLayer registers exactly while the layer is open', () => {
        const stack = createBackLayerStack()
        const state = $state({ open: false })
        const close = vi.fn(() => { state.open = false })
        const stop = $effect.root(() => {
            useBackLayer(BackLayerRank.Popup, () => state.open, close, stack)
        })
        flushSync()
        expect(stack.hasOpen()).toBe(false)

        state.open = true
        flushSync()
        expect(stack.hasOpen()).toBe(true)

        expect(stack.dismissTop()).toBe('closed')
        flushSync()
        expect(close).toHaveBeenCalledOnce()
        expect(stack.hasOpen()).toBe(false)

        state.open = true
        flushSync()
        stop()
        expect(stack.hasOpen()).toBe(false)
    })
})

describe('alertBackDismissal', () => {
    test('questions are answered no / cancel, never yes', () => {
        for (const type of ['ask', 'pluginconfirm', 'tos']) {
            expect(alertBackDismissal({ type, msg: 'question?' })).toEqual({ type: 'none', msg: 'no' })
        }
        expect(alertBackDismissal({ type: 'confirmMulti', msg: 'pick' })).toEqual({ type: 'none', msg: 'cancel' })
        expect(alertBackDismissal({ type: 'addchar', msg: '' })).toEqual({ type: 'none', msg: 'cancel' })
        expect(JSON.parse(alertBackDismissal({ type: 'cardexport', msg: '' })!.msg)).toMatchObject({ type: 'cancel' })
    })

    test('inputs and notices close with an empty answer', () => {
        for (const type of ['input', 'error', 'normal', 'markdown', 'requestdata', 'branches', 'selectModule']) {
            expect(alertBackDismissal({ type, msg: 'typed text' })).toEqual({ type: 'none', msg: '' })
        }
    })

    test('pickers, loading and unknown alerts are not dismissed', () => {
        for (const type of ['select', 'selectChar', 'login', 'wait', 'wait2', 'progress', 'pukmakkurit', 'somethingNew']) {
            expect(alertBackDismissal({ type, msg: '0' })).toBeNull()
        }
    })
})
