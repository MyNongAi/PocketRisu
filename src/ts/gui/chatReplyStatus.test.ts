import { get, writable } from 'svelte/store'
import { describe, expect, it } from 'vitest'
import { clearFinishedReply, finishedReplies, trackFinishedReplies } from './chatReplyStatus'
import { isSendKey } from './sendKey'

describe('trackFinishedReplies', () => {
    it('marks a chat when its generation ends and unmarks it when another starts', () => {
        finishedReplies.set(new Set())
        const running = writable(new Map<string, unknown>())
        const stop = trackFinishedReplies(running, ['nochat'])

        running.set(new Map([['a', {}], ['nochat', {}]]))
        expect([...get(finishedReplies)]).toEqual([])

        running.set(new Map())
        expect([...get(finishedReplies)]).toEqual(['a'])

        running.set(new Map([['a', {}]]))
        expect([...get(finishedReplies)]).toEqual([])
        stop()
    })

    it('clears a mark when the chat is opened', () => {
        finishedReplies.set(new Set(['a', 'b']))
        clearFinishedReply('a')
        expect([...get(finishedReplies)]).toEqual(['b'])
        clearFinishedReply(undefined)
        expect([...get(finishedReplies)]).toEqual(['b'])
    })
})

describe('isSendKey', () => {
    const key = (mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) =>
        ({ shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods })

    it('follows the configured send combination exactly', () => {
        expect(isSendKey(key(), 'enter')).toBe(true)
        expect(isSendKey(key({ shiftKey: true }), 'enter')).toBe(false)
        expect(isSendKey(key({ ctrlKey: true }), 'ctrl-enter')).toBe(true)
        expect(isSendKey(key({ ctrlKey: true, shiftKey: true }), 'ctrl-enter')).toBe(false)
        expect(isSendKey(key({ shiftKey: true }), 'shift-enter')).toBe(true)
        expect(isSendKey(key(), 'button')).toBe(false)
        expect(isSendKey(key(), undefined)).toBe(false)
    })
})
