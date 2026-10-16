import { afterEach, describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import { dockState, isMinimizedRequest, keepsDoneButton, minimizedRequests, minimizeRequest, unminimizeRequest } from './requestStatusDock'

afterEach(() => minimizedRequests.set([]))

describe('requestStatusDock', () => {
    it('folds and unfolds a request once, in order', () => {
        minimizeRequest('a')
        minimizeRequest('b')
        minimizeRequest('a')
        expect(get(minimizedRequests)).toEqual(['a', 'b'])
        unminimizeRequest('a')
        expect(isMinimizedRequest('a')).toBe(false)
        expect(get(minimizedRequests)).toEqual(['b'])
    })

    it('spins while running, checks when done, flags a failure or cancel', () => {
        expect(dockState({ phase: 'responding' })).toBe('running')
        expect(dockState({ phase: 'stalled' })).toBe('running')
        expect(dockState({ phase: 'done' })).toBe('done')
        expect(dockState({ phase: 'failed' })).toBe('failed')
        expect(dockState({ phase: 'aborted' })).toBe('failed')
    })

    it('keeps the check only for a main reply written in another chat', () => {
        expect(keepsDoneButton({ phase: 'done', kind: 'main', chatId: 'c1' }, 'c2')).toBe(true)
        expect(keepsDoneButton({ phase: 'done', kind: 'main', chatId: 'c1' }, 'c1')).toBe(false)
        expect(keepsDoneButton({ phase: 'done', kind: 'translate', chatId: 'c1' }, 'c2')).toBe(false)
        expect(keepsDoneButton({ phase: 'done', kind: 'main', chatId: undefined }, 'c2')).toBe(false)
        expect(keepsDoneButton({ phase: 'failed', kind: 'main', chatId: 'c1' }, 'c2')).toBe(false)
    })
})
