import { describe, expect, it } from 'vitest'
import {
    deleteShownSwipe,
    findRerollTargetIndex,
    hasBrowsableSwipes,
    stepSwipe,
    swipeCount,
    wrapSwipeIndex,
    type SwipeMessage,
} from './chatSwipes'

const user = (data = 'u'): SwipeMessage => ({ role: 'user', data })
const char = (data = 'c', extra: Partial<SwipeMessage> = {}): SwipeMessage => ({ role: 'char', data, ...extra })

describe('findRerollTargetIndex', () => {
    it('is the last reply when the chat ends on it', () => {
        expect(findRerollTargetIndex([user(), char(), user(), char()])).toBe(3)
    })

    it('skips trailing comments and disabled messages', () => {
        const disabledUser: SwipeMessage = { role: 'user', data: 'off', disabled: true }
        expect(findRerollTargetIndex([user(), char(), char('note', { isComment: true }), disabledUser])).toBe(1)
    })

    it('is -1 when the chat ends on the user turn or is empty', () => {
        expect(findRerollTargetIndex([user(), char(), user()])).toBe(-1)
        expect(findRerollTargetIndex([])).toBe(-1)
    })
})

describe('wrapSwipeIndex', () => {
    it('wraps in both directions', () => {
        expect(wrapSwipeIndex(-1, 3)).toBe(2)
        expect(wrapSwipeIndex(3, 3)).toBe(0)
        expect(wrapSwipeIndex(4, 3)).toBe(1)
        expect(wrapSwipeIndex(1, 0)).toBe(0)
    })
})

describe('stepSwipe', () => {
    it('moves forward and wraps from the last swipe to the first', () => {
        const message = char('b', { swipes: ['a', 'b'], swipeId: 1 })
        expect(stepSwipe(message, 1)).toBe(true)
        expect(message).toMatchObject({ swipeId: 0, data: 'a' })
    })

    it('moves back and wraps from the first swipe to the last', () => {
        const message = char('a', { swipes: ['a', 'b', 'c'], swipeId: 0 })
        expect(stepSwipe(message, -1)).toBe(true)
        expect(message).toMatchObject({ swipeId: 2, data: 'c' })
    })

    it('recovers from an out-of-range swipeId', () => {
        const message = char('?', { swipes: ['a', 'b', 'c'], swipeId: 5 })
        stepSwipe(message, 1)
        expect(message).toMatchObject({ swipeId: 0, data: 'a' })
    })

    it('does nothing without swipes', () => {
        const message = char('only')
        expect(stepSwipe(message, 1)).toBe(false)
        expect(message).toEqual(char('only'))
        expect(stepSwipe(char('x', { swipes: ['x'] }), 1)).toBe(false)
    })
})

describe('deleteShownSwipe', () => {
    it('deletes the shown swipe and shows the next one', () => {
        const message = char('b', { swipes: ['a', 'b', 'c'], swipeId: 1 })
        expect(deleteShownSwipe(message)).toEqual({ removedIndex: 1, previousCount: 3 })
        expect(message).toMatchObject({ swipes: ['a', 'c'], swipeId: 1, data: 'c' })
    })

    it('shows the new last swipe when the last one is deleted', () => {
        const message = char('c', { swipes: ['a', 'b', 'c'], swipeId: 2 })
        deleteShownSwipe(message)
        expect(message).toMatchObject({ swipes: ['a', 'b'], swipeId: 1, data: 'b' })
    })

    it('collapses to a plain message when one swipe remains', () => {
        const message = char('a', { swipes: ['a', 'b'], swipeId: 0 })
        expect(deleteShownSwipe(message)).toEqual({ removedIndex: 0, previousCount: 2 })
        expect(message).toEqual(char('b'))
    })

    it('refuses to delete the only candidate', () => {
        expect(deleteShownSwipe(char('a'))).toBeNull()
        expect(deleteShownSwipe(char('a', { swipes: ['a'], swipeId: 0 }))).toBeNull()
    })
})

describe('hasBrowsableSwipes', () => {
    it('needs a reply with more than one swipe', () => {
        expect(hasBrowsableSwipes(char('a', { swipes: ['a', 'b'], swipeId: 0 }))).toBe(true)
        expect(hasBrowsableSwipes(char('a', { swipes: ['a'], swipeId: 0 }))).toBe(false)
        expect(hasBrowsableSwipes(char('a'))).toBe(false)
        expect(hasBrowsableSwipes({ role: 'user', data: 'u', swipes: ['u', 'v'] })).toBe(false)
        expect(swipeCount(null)).toBe(0)
    })
})
