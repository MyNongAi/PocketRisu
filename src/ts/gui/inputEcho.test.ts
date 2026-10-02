import { describe, expect, it } from 'vitest'
import { inputEchoKey, previousInputIndex } from './inputEcho'

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
