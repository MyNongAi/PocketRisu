import { describe, expect, it } from 'vitest'
import { findTextMatches, splitAtMatches, stepMatch } from './textMatches'

describe('findTextMatches', () => {
    it('finds every occurrence, ignoring case', () => {
        expect(findTextMatches('Rain, rain, go away; RAIN', 'rain')).toEqual([[0, 4], [6, 10], [21, 25]])
    })

    it('takes the search text literally', () => {
        expect(findTextMatches('a.b a+b (x) {{user}}', '{{user}}')).toEqual([[12, 20]])
        expect(findTextMatches('a.b axb', 'a.b')).toEqual([[0, 3]])
        expect(findTextMatches('(x)', '(x)')).toEqual([[0, 3]])
    })

    it('finds nothing for an empty or blank search or text', () => {
        expect(findTextMatches('text', '')).toEqual([])
        expect(findTextMatches('text', '   ')).toEqual([])
        expect(findTextMatches('', 'a')).toEqual([])
        expect(findTextMatches(undefined, 'a')).toEqual([])
    })

    it('stops at the limit', () => {
        expect(findTextMatches('aaaaa', 'a', 3)).toHaveLength(3)
    })

    it('keeps offsets in the original text for Korean and emoji', () => {
        const text = '🙂 비가 온다. 비가 그친다'
        const matches = findTextMatches(text, '비가')
        expect(matches.map(([s, e]) => text.slice(s, e))).toEqual(['비가', '비가'])
    })
})

describe('splitAtMatches', () => {
    it('cuts the text into plain and marked pieces that join back to it', () => {
        const text = 'one two one'
        const segments = splitAtMatches(text, findTextMatches(text, 'one'))
        expect(segments).toEqual([
            { text: 'one', mark: 0 },
            { text: ' two ', mark: -1 },
            { text: 'one', mark: 1 },
        ])
        expect(segments.map((s) => s.text).join('')).toBe(text)
    })

    it('gives the whole text as one plain piece without matches', () => {
        expect(splitAtMatches('abc', [])).toEqual([{ text: 'abc', mark: -1 }])
        expect(splitAtMatches('', [])).toEqual([])
    })
})

describe('stepMatch', () => {
    it('wraps at both ends', () => {
        expect(stepMatch(2, 3, 1)).toBe(0)
        expect(stepMatch(0, 3, -1)).toBe(2)
        expect(stepMatch(1, 3, 1)).toBe(2)
    })

    it('starts at the first or last match from nowhere', () => {
        expect(stepMatch(-1, 3, 1)).toBe(0)
        expect(stepMatch(-1, 3, -1)).toBe(2)
        expect(stepMatch(5, 3, 1)).toBe(0)
        expect(stepMatch(0, 0, 1)).toBe(-1)
    })
})
