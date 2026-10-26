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

    it('groups exactly as comparing every pair does', () => {
        // The every-pair grouping the faster one replaced.
        const reference = (items: { name: string, id: number }[]) => {
            const parent = items.map((_, i) => i)
            const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]))
            const valid = items.map((item, i) => ({ i, n: normalizeDuplicateName(item.name) })).filter((e) => e.n)
            for (let l = 0; l < valid.length; l++) {
                for (let r = l + 1; r < valid.length; r++) {
                    const longest = Math.max(valid[l].n.length, valid[r].n.length)
                    if (Math.abs(valid[l].n.length - valid[r].n.length) / longest > 0.1) continue
                    if (duplicateNameSimilarity(valid[l].n, valid[r].n) >= 0.9) parent[find(valid[r].i)] = find(valid[l].i)
                }
            }
            const groups = new Map<number, number[]>()
            for (const e of valid) groups.set(find(e.i), [...(groups.get(find(e.i)) ?? []), items[e.i].id])
            return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => a - b).join(',')).sort()
        }
        let seed = 7
        const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
        const letters = 'abcde가나다 -'
        const word = (length: number) => Array.from({ length }, () => letters[Math.floor(random() * letters.length)]).join('')
        for (let round = 0; round < 20; round++) {
            const bases = Array.from({ length: 6 }, () => word(3 + Math.floor(random() * 22)))
            const items = Array.from({ length: 60 }, (_, id) => {
                const base = bases[Math.floor(random() * bases.length)]
                const at = Math.floor(random() * base.length)
                const variant = random() < 0.5 ? base : base.slice(0, at) + letters[Math.floor(random() * letters.length)] + base.slice(at + 1)
                return { name: random() < 0.1 ? '' : variant, id }
            })
            const fast = findHighSimilarityNameGroups(items)
                .map((group) => group.members.map((member) => member.id).sort((a, b) => a - b).join(','))
                .sort()
            expect(fast).toEqual(reference(items))
        }
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
