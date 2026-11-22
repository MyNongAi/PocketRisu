import { describe, expect, it } from 'vitest'
import { messageMatches, messageSnippet, searchTerms } from './chatSearch'

describe('CHAT-SEARCH matching and snippets', () => {
    it('matches the query as one phrase without case, spaces folded', () => {
        expect(searchTerms('  HELLO\n  세계  ')).toEqual(['hello 세계'])
        expect(messageMatches('Say hello\n\n세계!', searchTerms('hello 세계'))).toBe(true)
        expect(messageMatches('세계, Hello!', searchTerms('hello 세계'))).toBe(false)
        expect(messageMatches('입력 7 / 545b-0610', searchTerms('입력 6'))).toBe(false)
        expect(messageMatches('anything', searchTerms('  '))).toBe(false)
    })
    it('skips the branch card message', () => {
        expect(messageMatches('{{specialcomment::branchedfrom::id::입력 6::m::}}', searchTerms('입력 6'))).toBe(false)
    })
    it('cuts around the first match and marks both cuts', () => {
        const snippet = messageSnippet(`${'a'.repeat(40)} HIT ${'b'.repeat(100)}`, ['hit'])
        expect(snippet.text.startsWith('…')).toBe(true)
        expect(snippet.text.endsWith('…')).toBe(true)
        expect(snippet.parts.filter(part => part.hit).map(part => part.text)).toEqual(['HIT'])
    })
    it('highlights a match at the start and end', () => {
        expect(messageSnippet('cat in hat', ['cat', 'hat']).parts).toEqual([
            { text: 'cat', hit: true }, { text: ' in ', hit: false }, { text: 'hat', hit: true },
        ])
    })
    it('merges repeated and overlapping hits', () => {
        expect(messageSnippet('ababa aba', ['aba', 'bab']).parts).toEqual([
            { text: 'ababa', hit: true }, { text: ' ', hit: false }, { text: 'aba', hit: true },
        ])
        expect(messageSnippet('text', []).parts).toEqual([])
    })
})
