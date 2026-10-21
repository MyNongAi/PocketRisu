import { describe, expect, it } from 'vitest'
import { loreBookMatches, loreSearchNeedle } from './loreBookSearch'

describe('lorebook search', () => {
    const book = { comment: 'Castle Gate', key: 'gate, wall', secondkey: '', content: 'The north gate opens at dawn.' }

    it('matches the name, keys or content, ignoring case and spaces around', () => {
        expect(loreBookMatches(book, loreSearchNeedle('  castle '))).toBe(true)
        expect(loreBookMatches(book, loreSearchNeedle('WALL'))).toBe(true)
        expect(loreBookMatches(book, loreSearchNeedle('dawn'))).toBe(true)
        expect(loreBookMatches(book, loreSearchNeedle('dragon'))).toBe(false)
    })

    it('never lists folders, and an empty search matches nothing', () => {
        expect(loreBookMatches({ ...book, mode: 'folder' }, 'castle')).toBe(false)
        expect(loreBookMatches(book, loreSearchNeedle('   '))).toBe(false)
    })
})
