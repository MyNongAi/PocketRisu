import { get, writable } from 'svelte/store'
import { describe, expect, it } from 'vitest'
import { clearFinishedReply, finishedReplies, lastReplyOutcome, recordReplyOutcome, trackFinishedReplies, type ReplyOutcome } from './chatReplyStatus'
import { isSendKey } from './sendKey'

describe('trackFinishedReplies', () => {
    it('marks a chat when its generation ends and unmarks it when another starts', () => {
        finishedReplies.set(new Map())
        const running = writable(new Map<string, unknown>())
        const stop = trackFinishedReplies(running, ['nochat'])

        running.set(new Map([['a', {}], ['nochat', {}]]))
        expect([...get(finishedReplies)]).toEqual([])

        running.set(new Map())
        expect([...get(finishedReplies)]).toEqual([['a', 'done']])

        running.set(new Map([['a', {}]]))
        expect([...get(finishedReplies)]).toEqual([])
        stop()
    })

    it('clears a mark when the chat is opened', () => {
        finishedReplies.set(new Map<string, ReplyOutcome>([['a', 'done'], ['b', 'failed']]))
        clearFinishedReply('a')
        expect([...get(finishedReplies)]).toEqual([['b', 'failed']])
        clearFinishedReply(undefined)
        expect([...get(finishedReplies)]).toEqual([['b', 'failed']])
    })

    it('marks a failed send, suppresses a stopped send, and replaces either on a later run', () => {
        finishedReplies.set(new Map())
        const running = writable(new Map<string, unknown>())
        const stop = trackFinishedReplies(running)

        running.set(new Map([['a', {}]]))
        recordReplyOutcome('a', 'failed')
        running.set(new Map())
        expect(get(finishedReplies).get('a')).toBe('failed')
        clearFinishedReply('a')
        expect(lastReplyOutcome('a')).toBe('failed')

        running.set(new Map([['a', {}]]))
        expect(get(finishedReplies).has('a')).toBe(false)
        expect(lastReplyOutcome('a')).toBeUndefined()
        recordReplyOutcome('a', 'aborted')
        recordReplyOutcome('a', 'failed') // a late error after Stop must not mark the chat
        running.set(new Map())
        expect(get(finishedReplies).has('a')).toBe(false)

        running.set(new Map([['a', {}]]))
        running.set(new Map())
        expect(get(finishedReplies).get('a')).toBe('done')
        stop()
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
