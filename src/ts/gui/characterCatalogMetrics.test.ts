import { describe, expect, it } from 'vitest'
import {
    buildExactCharacterDuplicateCounts,
    exactCharacterDefinitionFingerprint,
} from './characterCatalogMetrics'

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
