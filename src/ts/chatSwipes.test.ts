import { describe, expect, it } from 'vitest'
import {
    dropShownSwipe,
    isErrorLikeReply,
    markErrorLikeReply,
    shiftErrorMarkAfterDelete,
    shownSwipeIsErrorLike,
    deleteShownSwipe,
    findLastReplyIndex,
    findRerollTargetIndex,
    hasBrowsableSwipes,
    hasUnseenSwipe,
    markNewSwipe,
    seeShownSwipe,
    shiftNewMarkAfterDelete,
    showSwipe,
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

describe('findLastReplyIndex', () => {
    it('is the last reply even when the user spoke after it', () => {
        expect(findLastReplyIndex([user(), char(), user()])).toBe(1)
        expect(findLastReplyIndex([user(), char(), char('note', { isComment: true }), char('off', { disabled: true })])).toBe(1)
    })

    it('is -1 without a reply and skips empty slots', () => {
        expect(findLastReplyIndex([user()])).toBe(-1)
        expect(findLastReplyIndex([char(), null, undefined])).toBe(0)
    })
})

describe('showSwipe', () => {
    it('shows the swipe at the index', () => {
        const message = char('a', { swipes: ['a', 'b', 'c'], swipeId: 0 })
        expect(showSwipe(message, 2)).toBe(true)
        expect(message).toMatchObject({ swipeId: 2, data: 'c' })
    })

    it('refuses an index the message does not have', () => {
        const message = char('a', { swipes: ['a', 'b'], swipeId: 0 })
        expect(showSwipe(message, 2)).toBe(false)
        expect(showSwipe(message, -1)).toBe(false)
        expect(showSwipe(message, 0.5)).toBe(false)
        expect(showSwipe(char('a'), 0)).toBe(false)
        expect(message).toMatchObject({ swipeId: 0, data: 'a' })
    })
})

describe('error-like replies', () => {
    const long = 'x'.repeat(101)

    it('flags a reply within 10 s and 100 characters', () => {
        expect(isErrorLikeReply('Error: blocked', 3_000)).toBe(true)
        expect(isErrorLikeReply('  short  ', 9_999)).toBe(true)
        expect(isErrorLikeReply(long, 3_000)).toBe(false)
        expect(isErrorLikeReply('Error: blocked', 10_000)).toBe(false)
    })

    it('marks the shown swipe, and a later real reply clears it', () => {
        const message = { role: 'char', data: 'Error', swipes: ['old answer ' + long, 'Error'], swipeId: 1 } as any
        markErrorLikeReply(message, 2_000)
        expect(message.nodeOnlyErrorSwipe).toBe(1)
        expect(shownSwipeIsErrorLike(message)).toBe(true)
        message.data = message.swipes[1] = long
        expect(shownSwipeIsErrorLike(message)).toBe(false) // edited into a real reply
        markErrorLikeReply(message, 20_000)
        expect(message.nodeOnlyErrorSwipe).toBeUndefined()
    })

    it('drops the shown page and lands on its neighbour in the arrow direction', () => {
        const back = { role: 'char', data: 'Err', swipes: ['a', 'b', 'Err'], swipeId: 2 } as any
        expect(dropShownSwipe(back, -1)).toEqual({ removedIndex: 2, previousCount: 3 })
        expect(back).toMatchObject({ swipes: ['a', 'b'], swipeId: 1, data: 'b' })

        const middle = { role: 'char', data: 'Err', swipes: ['a', 'Err', 'c'], swipeId: 1 } as any
        dropShownSwipe(middle, -1)
        expect(middle).toMatchObject({ swipeId: 0, data: 'a' })
        const forward = { role: 'char', data: 'Err', swipes: ['a', 'Err', 'c'], swipeId: 1 } as any
        dropShownSwipe(forward, 1)
        expect(forward).toMatchObject({ swipeId: 1, data: 'c' })

        const pair = { role: 'char', data: 'Err', swipes: ['a', 'Err'], swipeId: 1 } as any
        dropShownSwipe(pair, -1)
        expect(pair.swipes).toBeUndefined()
        expect(pair.data).toBe('a')
    })

    it('keeps the mark on the same swipe when another one is deleted', () => {
        const message = { role: 'char', data: 'a', swipes: ['a', 'b', 'Err'], swipeId: 0, nodeOnlyErrorSwipe: 2 } as any
        shiftErrorMarkAfterDelete(message, 0)
        expect(message.nodeOnlyErrorSwipe).toBe(1)
        shiftErrorMarkAfterDelete(message, 1)
        expect(message.nodeOnlyErrorSwipe).toBeUndefined()
    })
})

describe('new page a reroll left unseen', () => {
    it('marks a page other than the shown one and drops the mark once it is shown', () => {
        const message = { role: 'char', data: 'a', swipes: ['a', 'b', 'c'], swipeId: 0 } as any
        markNewSwipe(message, 2)
        expect(hasUnseenSwipe(message)).toBe(true)
        stepSwipe(message, 1)
        seeShownSwipe(message)
        expect(message.nodeOnlyNewSwipe).toBe(2)
        stepSwipe(message, 1)
        seeShownSwipe(message)
        expect(message.nodeOnlyNewSwipe).toBeUndefined()
        expect(hasUnseenSwipe(message)).toBe(false)
    })

    it('does not mark the shown page or one out of range', () => {
        const message = { role: 'char', data: 'b', swipes: ['a', 'b'], swipeId: 1 } as any
        markNewSwipe(message, 1)
        markNewSwipe(message, 2)
        markNewSwipe(message, -1)
        expect(message.nodeOnlyNewSwipe).toBeUndefined()
        expect(hasUnseenSwipe(char('x'))).toBe(false)
        expect(hasUnseenSwipe(null)).toBe(false)
    })

    it('keeps the mark on the same page when another one is deleted', () => {
        const message = { role: 'char', data: 'a', swipes: ['a', 'b', 'c'], swipeId: 0, nodeOnlyNewSwipe: 2 } as any
        shiftNewMarkAfterDelete(message, 1)
        expect(message.nodeOnlyNewSwipe).toBe(1)
        shiftNewMarkAfterDelete(message, 1)
        expect(message.nodeOnlyNewSwipe).toBeUndefined()
    })
})
