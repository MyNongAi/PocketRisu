import { describe, expect, it } from 'vitest'
import {
    duplicateNameSimilarity,
    findHighSimilarityNameGroups,
    normalizeDuplicateName,
} from './sourceCollectionDuplicates'

describe('source collection duplicate candidates', () => {
    it('normalizes casing, whitespace, and punctuation without removing versions', () => {
        expect(normalizeDuplicateName(' Nahida - Card ')).toBe('nahidacard')
        expect(normalizeDuplicateName('Nahida v2')).not.toBe(normalizeDuplicateName('Nahida v3'))
    })

    it('requires exact matches for short names and accepts high-confidence long typos', () => {
        expect(duplicateNameSimilarity('가나다', '가나마')).toBe(0)
        expect(duplicateNameSimilarity('NahidaCard', 'NahidaCrd')).toBeGreaterThanOrEqual(0.9)
    })

    it('returns duplicate groups while leaving unrelated entries alone', () => {
        const first = { name: 'Nahida Card', id: 'a' }
        const second = { name: 'nahida-card', id: 'b' }
        const groups = findHighSimilarityNameGroups([first, { name: 'Furina', id: 'c' }, second])
        expect(groups).toHaveLength(1)
        expect(groups[0].key).toBe('nahidacard')
        expect(groups[0].members).toEqual([first, second])
    })
})
