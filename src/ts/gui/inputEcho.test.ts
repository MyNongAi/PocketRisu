import { describe, expect, it } from 'vitest'
import { echoedInputIndex, inputEchoKey, nextReplyIndex, previousInputIndex } from './inputEcho'

describe('echoedInputIndex', () => {
    it('shows only an input the user sent from the input box (2026-11-07)', () => {
        const typed = { role: 'user', time: 1, data: 'Go to class' }
        const botRequest = { role: 'user', data: '[ACADEMY_REQUEST:2:1:19]\n## Academy Observation' }
        const saysNothing = { role: 'user', data: '*says nothing*' }
        const onlyBlock = { role: 'user', time: 1, data: '[SIM_REQUEST_CONTEXT]\ncues\n[/SIM_REQUEST_CONTEXT]' }
        const char = { role: 'char', data: 'reply' }
        expect(echoedInputIndex([typed, char], 1)).toBe(0)
        expect(echoedInputIndex([botRequest, char], 1)).toBe(-1)
        expect(echoedInputIndex([saysNothing, char], 1)).toBe(-1)
        expect(echoedInputIndex([onlyBlock, char], 1)).toBe(-1)
        // The pairing of inputs and replies itself is unchanged.
        expect(previousInputIndex([botRequest, char], 1)).toBe(0)
    })
})

describe('previousInputIndex', () => {
    const user = { role: 'user' }
    const char = { role: 'char' }
    const comment = { role: 'char', isComment: true }

    it('finds the user message right before a reply', () => {
        expect(previousInputIndex([char, user, char], 2)).toBe(1)
    })

    it('skips comments between the input and the reply', () => {
        expect(previousInputIndex([user, comment, char], 2)).toBe(0)
    })

    it('gives none to a reply that follows another reply', () => {
        expect(previousInputIndex([user, char, char], 2)).toBe(-1)
    })

    it('gives none when nothing comes before', () => {
        expect(previousInputIndex([char], 0)).toBe(-1)
        expect(previousInputIndex([comment, char], 1)).toBe(-1)
    })
})

describe('inputEchoKey', () => {
    it('prefers the message id and falls back to the index', () => {
        expect(inputEchoKey({ chatId: 'm-1' }, 3)).toBe('id:m-1')
        expect(inputEchoKey({}, 3)).toBe('index:3')
        expect(inputEchoKey(undefined, 0)).toBe('index:0')
    })
})

describe('nextReplyIndex', () => {
    it('finds the reply an input is answered by, past comments', () => {
        const messages = [{ role: 'user' }, { role: 'char', isComment: true }, { role: 'char' }, { role: 'user' }, { role: 'user' }]
        expect(nextReplyIndex(messages, 0)).toBe(2)
        expect(nextReplyIndex(messages, 3)).toBe(-1)
        expect(nextReplyIndex(messages, 4)).toBe(-1)
    })
})
