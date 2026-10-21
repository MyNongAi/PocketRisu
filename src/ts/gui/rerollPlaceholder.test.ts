import { beforeEach, describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import {
    clearRerollPlaceholder,
    heldRerollSwipe,
    rerollPlaceholderPages,
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
        expect(stepRerollPlaceholderSwipe('c1', 1, false)).toBe(true)
        expect(get(rerollPlaceholders).get('c1')?.message).toMatchObject({ data: 'C', swipeId: 2 })
        expect(stepRerollPlaceholderSwipe('c1', 1, false)).toBe(true)
        expect(get(rerollPlaceholders).get('c1')?.message).toMatchObject({ data: 'A', swipeId: 0 })
        expect(original).toMatchObject({ data: 'B', swipeId: 1 })
    })

    it('has nothing to browse for a reply without swipes or an unknown chat, and clears per chat', () => {
        setRerollPlaceholder({ chatId: 'c1', index: 1, message: { role: 'char', data: 'only' } })
        setRerollPlaceholder({ chatId: 'c2', index: 3, message: old })
        expect(stepRerollPlaceholderSwipe('c1', 1, false)).toBe(false)
        expect(stepRerollPlaceholderSwipe('nope', 1, false)).toBe(false)
        clearRerollPlaceholder('c1')
        expect([...get(rerollPlaceholders).keys()]).toEqual(['c2'])
    })
})

describe('a held placeholder', () => {
    beforeEach(() => rerollPlaceholders.set(new Map()))

    it("counts no new page before the new reply has text (the user's request, 2026-10-22)", () => {
        setRerollPlaceholder({ chatId: 'c1', index: 1, message: { ...old, swipes: [...old.swipes] }, hold: true })
        expect(rerollPlaceholderPages(get(rerollPlaceholders).get('c1')!, false)).toEqual({ current: 2, total: 3 })
        // past the last old page it goes round, not onto a page with nothing on it
        expect(stepRerollPlaceholderSwipe('c1', 1, false)).toBe(true)
        expect(stepRerollPlaceholderSwipe('c1', 1, false)).toBe(true)
        const round = get(rerollPlaceholders).get('c1')!
        expect(round.showingNew).toBeFalsy()
        expect(rerollPlaceholderPages(round, false)).toEqual({ current: 1, total: 3 })
        // once it has text, the page is there
        expect(rerollPlaceholderPages(round, true)).toEqual({ current: 1, total: 4 })
        // a reply without swipes stays 1/1 with nothing to step to
        setRerollPlaceholder({ chatId: 'c2', index: 1, message: { role: 'char', data: 'only' }, hold: true })
        expect(rerollPlaceholderPages(get(rerollPlaceholders).get('c2')!, false)).toEqual({ current: 1, total: 1 })
        expect(stepRerollPlaceholderSwipe('c2', 1, false)).toBe(false)
    })

    it('stays for the whole reroll, even once the new reply has text', () => {
        expect(rerollPlaceholderShows([user, { role: 'char', data: 'new' }], { index: 1, hold: true })).toBe(true)
    })

    it('counts the new reply as one more page and lets it show when stepped onto', () => {
        setRerollPlaceholder({ chatId: 'c1', index: 1, message: { ...old, swipes: [...old.swipes] }, hold: true })
        expect(rerollPlaceholderPages(get(rerollPlaceholders).get('c1')!, true)).toEqual({ current: 2, total: 4 })
        expect(heldRerollSwipe('c1')).toBe(1)
        // within the old pages it browses as before
        expect(stepRerollPlaceholderSwipe('c1', 1, true)).toBe(true)
        expect(heldRerollSwipe('c1')).toBe(2)
        // one past the last old page is the new reply: the copy stays held, on its last page
        expect(stepRerollPlaceholderSwipe('c1', 1, true)).toBe(true)
        const onNew = get(rerollPlaceholders).get('c1')!
        expect(onNew.hold).toBe(true)
        expect(onNew.showingNew).toBe(true)
        expect(rerollPlaceholderPages(onNew, true)).toEqual({ current: 4, total: 4 })
        expect(heldRerollSwipe('c1')).toBeNull()
        // the new reply shows there: an empty stream start too, as that page
        expect(rerollPlaceholderShows([user, { role: 'char', data: 'new' }], onNew)).toBe(false)
        expect(rerollPlaceholderShows([user, { role: 'char', data: '' }], onNew)).toBe(true)
    })

    it("steps back from the new reply to the old pages (the user's report, 2026-10-21)", () => {
        setRerollPlaceholder({ chatId: 'c1', index: 1, message: { ...old, swipes: [...old.swipes], swipeId: 2 }, hold: true, showingNew: true })
        expect(stepRerollPlaceholderSwipe('c1', -1, true)).toBe(true)
        const back = get(rerollPlaceholders).get('c1')!
        expect(back.showingNew).toBe(false)
        expect(rerollPlaceholderPages(back, true)).toEqual({ current: 3, total: 4 })
        expect(heldRerollSwipe('c1')).toBe(2)
        expect(back.message.data).toBe(old.swipes[2])
        expect(rerollPlaceholderShows([user, { role: 'char', data: 'new' }], back)).toBe(true)
        // and round from the new page forward to the first old one
        setRerollPlaceholder({ ...back, showingNew: true })
        expect(stepRerollPlaceholderSwipe('c1', 1, true)).toBe(true)
        expect(rerollPlaceholderPages(get(rerollPlaceholders).get('c1')!, true)).toEqual({ current: 1, total: 4 })
        // the text follows the page (the review, 2026-10-21: it kept the page left before)
        expect(get(rerollPlaceholders).get('c1')!.message.data).toBe(old.swipes[0])
    })

    it('reaches the new page backwards from the first one, and from a reply without swipes', () => {
        setRerollPlaceholder({ chatId: 'c1', index: 1, message: { ...old, swipeId: 0, data: 'A' }, hold: true })
        expect(stepRerollPlaceholderSwipe('c1', -1, true)).toBe(true)
        expect(get(rerollPlaceholders).get('c1')?.showingNew).toBe(true)

        setRerollPlaceholder({ chatId: 'c2', index: 1, message: { role: 'char', data: 'only' }, hold: true })
        expect(rerollPlaceholderPages(get(rerollPlaceholders).get('c2')!, true)).toEqual({ current: 1, total: 2 })
        expect(heldRerollSwipe('c2')).toBe(0)
        expect(stepRerollPlaceholderSwipe('c2', 1, true)).toBe(true)
        expect(heldRerollSwipe('c2')).toBeNull()
    })
})
