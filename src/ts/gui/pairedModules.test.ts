import { describe, expect, test } from 'vitest'
import { backfillModulePairs, characterModuleLink, charactersByPairedModule, forgetModulePair, moduleLinks, recordModulePair } from './pairedModules'

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

describe('chain states', () => {
    test('a bot is green while all its modules exist and red once one is gone', () => {
        const existing = new Set(['m1', 'm2'])
        expect(characterModuleLink({ modules: ['m1', 'm2'] }, existing)).toBe('linked')
        expect(characterModuleLink({ modules: ['m1', 'gone'] }, existing)).toBe('broken')
        expect(characterModuleLink({ modules: [] }, existing)).toBeNull()
        expect(characterModuleLink(undefined, existing)).toBeNull()
    })

    test('a module is green while a bot lists it and red once its paired bots are gone', () => {
        const modules = [
            { id: 'live', nodeOnlyPairedCharacterIds: ['a'] },
            { id: 'orphan', nodeOnlyPairedCharacterIds: ['gone'] },
            { id: 'trashed', nodeOnlyPairedCharacterIds: ['t'] },
            { id: 'sleeping', nodeOnlyPairedCharacterIds: ['s'] },
            { id: 'plain' },
        ]
        const characters = [
            { chaId: 'a', name: 'A', modules: ['live'] },
            { chaId: 't', name: 'T', modules: ['trashed'], trashTime: 1 },
        ]
        const links = moduleLinks(modules, characters, [{ chaId: 's', name: 'S' }])
        expect(links.get('live')).toEqual({ state: 'linked', names: ['A'] })
        expect(links.get('orphan')).toEqual({ state: 'broken', names: ['삭제된 봇'] })
        expect(links.get('trashed')).toEqual({ state: 'broken', names: ['T'] })
        expect(links.get('sleeping')).toEqual({ state: 'linked', names: ['S'] })
        expect(links.has('plain')).toBe(false)
    })

    test('pairs are recorded, forgotten on purpose and backfilled from the bots', () => {
        const modules: { id: string, nodeOnlyPairedCharacterIds?: string[] }[] = [{ id: 'm1' }, { id: 'm2' }]
        recordModulePair(modules, ['m1'], 'a')
        recordModulePair(modules, ['m1'], 'a')
        expect(modules[0].nodeOnlyPairedCharacterIds).toEqual(['a'])
        forgetModulePair(modules, 'm1', 'a')
        expect(modules[0].nodeOnlyPairedCharacterIds).toBeUndefined()
        expect(backfillModulePairs(modules, [{ chaId: 'b', modules: ['m2', 'missing'] }])).toBe(true)
        expect(modules[1].nodeOnlyPairedCharacterIds).toEqual(['b'])
        expect(backfillModulePairs(modules, [{ chaId: 'b', modules: ['m2'] }])).toBe(false)
    })
})
