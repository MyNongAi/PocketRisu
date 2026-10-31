import { describe, expect, it } from 'vitest'
import {
    buildCharacterNameSimilarityCounts,
    buildExactCharacterDuplicateCounts,
    buildTrashNameSimilarityCounts,
    countCatalogCharacters,
    exactCharacterDefinitionFingerprint,
} from './characterCatalogMetrics'

describe('countCatalogCharacters', () => {
    const live = [{ chaId: 'a', name: 'Alice' }, { chaId: 'b', name: 'Bob' }, { chaId: 't', name: 'Trashed', trashTime: 1 }, null]
    const archived = [{ chaId: 'c', name: 'Carol' }, { chaId: 'd', name: 'Dave', trashedAt: 2 }, { name: 'no id' }]

    it('counts live bots, then live and deactivated together, leaving the trash out', () => {
        expect(countCatalogCharacters(live, archived)).toEqual({ active: 2, all: 3 })
        expect(countCatalogCharacters([], [])).toEqual({ active: 0, all: 0 })
    })

    it('a search narrows both numbers', () => {
        expect(countCatalogCharacters(live, archived, (name) => /o/i.test(name))).toEqual({ active: 1, all: 2 })
    })
})

function card(id: string, extra: Record<string, unknown> = {}) {
    return {
        chaId: id,
        name: 'Same',
        desc: 'definition',
        globalLore: [{ key: 'a', content: 'lore' }],
        additionalAssets: [['face', 'assets/a', 'png']],
        chats: [{ id: `chat-${id}`, message: [id] }],
        lastInteraction: id === 'a' ? 1 : 2,
        sourceInfo: { label: id },
        ...extra,
    }
}

describe('character catalog exact duplicate metrics', () => {
    it('ignores copy/chat state but includes lore and ordered asset references', () => {
        expect(exactCharacterDefinitionFingerprint(card('a')))
            .toBe(exactCharacterDefinitionFingerprint(card('b')))
        expect(exactCharacterDefinitionFingerprint(card('a')))
            .not.toBe(exactCharacterDefinitionFingerprint(card('c', {
                additionalAssets: [['face', 'assets/other', 'png']],
            })))
    })

    it('returns the number of other exact copies and ignores trash', async () => {
        const counts = await buildExactCharacterDuplicateCounts([
            card('a'),
            card('b'),
            card('different', { desc: 'changed' }),
            card('trash', { trashTime: 10 }),
        ], [], { yieldEvery: 100 })

        expect(counts.get('a')).toBe(1)
        expect(counts.get('b')).toBe(1)
        expect(counts.get('different')).toBe(0)
        expect(counts.has('trash')).toBe(false)
    })

    it('keeps a fingerprinted deactivated copy in the same group', async () => {
        const active = card('active')
        const fingerprint = exactCharacterDefinitionFingerprint(active)
        const counts = await buildExactCharacterDuplicateCounts([active], [{
            chaId: 'cold',
            exactDefinitionFingerprint: fingerprint,
        }], { yieldEvery: 100 })

        expect(counts.get('active')).toBe(1)
        expect(counts.get('cold')).toBe(1)
    })
})

describe('character catalog similarity metrics', () => {
    it('counts the other bots with a name 90% or more alike, deactivated ones included', () => {
        const counts = buildCharacterNameSimilarityCounts([
            { chaId: 'a', name: 'Nahida Card' },
            { chaId: 'b', name: 'nahida-card' },
            { chaId: 'c', name: 'Furina' },
        ], [
            { chaId: 'd', name: 'Nahida  Card!' },
        ])
        expect(counts.get('a')).toBe(2)
        expect(counts.get('b')).toBe(2)
        expect(counts.get('d')).toBe(2)
        expect(counts.has('c')).toBe(false)
    })

    it('leaves the trash and nameless bots out', () => {
        const counts = buildCharacterNameSimilarityCounts([
            { chaId: 'a', name: 'Mary Sisters' },
            { chaId: 't', name: 'Mary Sisters', trashTime: 1 },
            { chaId: 'x', name: '' },
            { chaId: 'y', name: '' },
        ], [
            { chaId: 's', name: 'Mary Sisters', trashedAt: 2 },
        ])
        expect(counts.size).toBe(0)
    })

    it('does not look at folders: a bot out of its candidate folder keeps the count', () => {
        const bots = [{ chaId: 'a', name: 'Mary Sisters' }, { chaId: 'b', name: 'Mary  Sisters' }]
        expect(buildCharacterNameSimilarityCounts(bots).get('b')).toBe(1)
    })

    it('gives the same map back while the names stay the same', () => {
        const first = buildCharacterNameSimilarityCounts([{ chaId: 'a', name: 'Same Name' }, { chaId: 'b', name: 'Same Name' }])
        expect(buildCharacterNameSimilarityCounts([{ chaId: 'a', name: 'Same Name' }, { chaId: 'b', name: 'Same Name' }])).toBe(first)
        const renamed = buildCharacterNameSimilarityCounts([{ chaId: 'a', name: 'Same Name' }, { chaId: 'b', name: 'Other Thing' }])
        expect(renamed).not.toBe(first)
        expect(renamed.size).toBe(0)
    })
})

describe('the similar count in the trash', () => {
    it('counts, for a bot in the trash, the alike bots kept outside it', () => {
        const counts = buildTrashNameSimilarityCounts([
            { chaId: 'a', name: 'Mary Sisters' },
            { chaId: 't', name: 'Mary Sisters', trashTime: 1 },
            { chaId: 'u', name: 'Lonely Trashed', trashTime: 1 },
        ], [
            { chaId: 'd', name: 'Mary  Sisters!' },
            { chaId: 's', name: 'Mary Sisters', trashedAt: 2 },
        ])
        // a (live) and d (deactivated); the other trashed copy keeps nothing.
        expect(counts.get('t')).toBe(2)
        expect(counts.get('s')).toBe(2)
        expect(counts.has('u')).toBe(false)
        // Only the trash gets a number here.
        expect(counts.has('a')).toBe(false)
        expect(counts.has('d')).toBe(false)
    })

    it('shows nothing for copies that are all in the trash', () => {
        expect(buildTrashNameSimilarityCounts([], [
            { chaId: 's', name: 'Mary Sisters', trashedAt: 2 },
            { chaId: 'r', name: 'Mary Sisters', trashedAt: 3 },
        ]).size).toBe(0)
        expect(buildTrashNameSimilarityCounts([{ chaId: 'a', name: 'Mary Sisters' }]).size).toBe(0)
    })

    it('counts again when a bot goes in or out of the trash', () => {
        const kept = [{ chaId: 'a', name: 'Same Name' }, { chaId: 'b', name: 'Same Name' }]
        expect(buildTrashNameSimilarityCounts([...kept, { chaId: 't', name: 'Same Name', trashTime: 1 }]).get('t')).toBe(2)
        expect(buildTrashNameSimilarityCounts([kept[0], { ...kept[1], trashTime: 1 }, { chaId: 't', name: 'Same Name', trashTime: 1 }]).get('t')).toBe(1)
    })
})
