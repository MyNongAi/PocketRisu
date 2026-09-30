import { describe, expect, test } from 'vitest'
import { charactersByPairedModule } from './pairedModules'

describe('charactersByPairedModule', () => {
    test('maps each module to the bots that have it as their own module', () => {
        const pairs = charactersByPairedModule([
            { name: 'A', modules: ['m1', 'm2', 'm1'] },
            { name: 'B', modules: ['m1'] },
            { name: 'C' },
            null,
            { modules: ['m3'] },
        ])
        expect(pairs.get('m1')).toEqual(['A', 'B'])
        expect(pairs.get('m2')).toEqual(['A'])
        expect(pairs.get('m3')).toEqual(['Unnamed'])
        expect(pairs.has('m4')).toBe(false)
    })
})
