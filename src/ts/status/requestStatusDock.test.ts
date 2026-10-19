import { afterEach, describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import { dismissRequestToast, staysOpenUnseen, dockState, isMinimizedRequest, keepsDoneButton, minimizedRequests, minimizeRequest, requestToastDismissed, requestToastShown, unminimizeRequest } from './requestStatusDock'
import { requestStatuses } from './requestStatus'

afterEach(() => {
    minimizedRequests.set([])
    requestStatuses.set(new Map())
})

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

    it('folds a running request when its card is swiped, not when the app closes it', () => {
        requestStatuses.set(new Map([
            ['run', { phase: 'streaming' } as any],
            ['done', { phase: 'done' } as any],
        ]))
        requestToastShown('run')
        requestToastDismissed('run')
        expect(isMinimizedRequest('run')).toBe(true)
        unminimizeRequest('run')

        // The app's own dismissal (the "−", a finished card leaving) is not a swipe.
        dismissRequestToast('run')
        requestToastDismissed('run')
        expect(isMinimizedRequest('run')).toBe(false)

        // A finished request's card just closes.
        requestToastDismissed('done')
        expect(isMinimizedRequest('done')).toBe(false)
    })

    it('keeps an open card of a reply finished in another chat until that chat is on screen', () => {
        const done = { phase: 'done', kind: 'main', chatId: 'other' } as const
        expect(staysOpenUnseen(done, 'here')).toBe(true)
        expect(staysOpenUnseen({ ...done, phase: 'failed' }, 'here')).toBe(true)
        expect(staysOpenUnseen(done, 'other')).toBe(false)
        expect(staysOpenUnseen({ ...done, kind: 'translate' }, 'here')).toBe(false)
        expect(staysOpenUnseen({ ...done, phase: 'aborted' }, 'here')).toBe(false)
    })
})
