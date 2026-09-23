import { describe, expect, it } from 'vitest'
import {
    BLANK_FIRST_MESSAGE_INDEX,
    firstMessagePageNumber,
    getFirstMessageAtIndex,
    lastFirstMessagePageNumber,
    nextFirstMessageIndex,
    previousFirstMessageIndex,
} from './firstMessage'

const source = { firstMessage: 'default', alternateGreetings: ['alt-a', 'alt-b'] }

describe('first-message page zero', () => {
    it('keeps page zero synthetic and preserves the card greetings', () => {
        expect(getFirstMessageAtIndex(source, BLANK_FIRST_MESSAGE_INDEX)).toBe('')
        expect(getFirstMessageAtIndex(source, -1)).toBe('default')
        expect(getFirstMessageAtIndex(source, 0)).toBe('alt-a')
        expect(source).toEqual({ firstMessage: 'default', alternateGreetings: ['alt-a', 'alt-b'] })
    })

    it('cycles blank, default and alternates in both directions', () => {
        expect(nextFirstMessageIndex(-2, 2)).toBe(-1)
        expect(nextFirstMessageIndex(1, 2)).toBe(-2)
        expect(previousFirstMessageIndex(-2, 2)).toBe(1)
        expect(previousFirstMessageIndex(-1, 2)).toBe(-2)
    })

    it('uses zero-based visible page numbers', () => {
        expect(firstMessagePageNumber(-2)).toBe(0)
        expect(firstMessagePageNumber(-1)).toBe(1)
        expect(firstMessagePageNumber(0)).toBe(2)
        expect(lastFirstMessagePageNumber(0)).toBe(1)
        expect(lastFirstMessagePageNumber(2)).toBe(3)
    })
})
