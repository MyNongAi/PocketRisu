import { beforeEach, describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import {
    clearRerollPlaceholder,
    rerollPlaceholderShows,
    rerollPlaceholders,
    setRerollPlaceholder,
    stepRerollPlaceholderSwipe,
} from './rerollPlaceholder'

const user = { role: 'user', data: 'hi' }
const old = { role: 'char', data: 'B', swipes: ['A', 'B', 'C'], swipeId: 1 }

describe('rerollPlaceholderShows', () => {
    it('stands in while nothing is at the old place, or only an empty stream start', () => {
        expect(rerollPlaceholderShows([user], { index: 1 })).toBe(true)
        expect(rerollPlaceholderShows([user, { role: 'char', data: '' }], { index: 1 })).toBe(true)
    })

    it('gives way once the new reply has text, or the old one is back', () => {
        expect(rerollPlaceholderShows([user, { role: 'char', data: 'new' }], { index: 1 })).toBe(false)
        expect(rerollPlaceholderShows([user, old], { index: 1 })).toBe(false)
        expect(rerollPlaceholderShows([user], null)).toBe(false)
    })
})

describe('the placeholder store', () => {
    beforeEach(() => rerollPlaceholders.set(new Map()))

    it('browses the copy\'s swipes without touching the original', () => {
        const original = { ...old, swipes: [...old.swipes] }
        setRerollPlaceholder({ chatId: 'c1', index: 1, message: original })
        expect(stepRerollPlaceholderSwipe('c1', 1)).toBe(true)
        expect(get(rerollPlaceholders).get('c1')?.message).toMatchObject({ data: 'C', swipeId: 2 })
        expect(stepRerollPlaceholderSwipe('c1', 1)).toBe(true)
        expect(get(rerollPlaceholders).get('c1')?.message).toMatchObject({ data: 'A', swipeId: 0 })
        expect(original).toMatchObject({ data: 'B', swipeId: 1 })
    })

    it('has nothing to browse for a reply without swipes or an unknown chat, and clears per chat', () => {
        setRerollPlaceholder({ chatId: 'c1', index: 1, message: { role: 'char', data: 'only' } })
        setRerollPlaceholder({ chatId: 'c2', index: 3, message: old })
        expect(stepRerollPlaceholderSwipe('c1', 1)).toBe(false)
        expect(stepRerollPlaceholderSwipe('nope', 1)).toBe(false)
        clearRerollPlaceholder('c1')
        expect([...get(rerollPlaceholders).keys()]).toEqual(['c2'])
    })
})
