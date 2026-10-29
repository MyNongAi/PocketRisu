import { describe, expect, test } from 'vitest'
import { backfillModulePairs, botsOfModule, characterModuleLink, dropMissingBotModules, folderBotLinkChange, charactersByPairedModule, forgetModulePair, moduleLinks, modulesOfBot, recordModulePair } from './pairedModules'

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
            { id: 'deleted', nodeOnlyPairedCharacterIds: ['d'] },
            { id: 'plain' },
        ]
        const characters = [
            { chaId: 'a', name: 'A', modules: ['live'] },
            { chaId: 't', name: 'T', modules: ['trashed'], trashTime: 1 },
        ]
        // a bot deleted now is a deactivated stub marked trashedAt
        const links = moduleLinks(modules, characters, [{ chaId: 's', name: 'S' }, { chaId: 'd', name: 'D', trashedAt: 5 }])
        expect(links.get('live')).toEqual({ state: 'linked', names: ['A'] })
        expect(links.get('orphan')).toEqual({ state: 'broken', names: ['삭제된 봇'] })
        expect(links.get('trashed')).toEqual({ state: 'broken', names: ['T'] })
        expect(links.get('sleeping')).toEqual({ state: 'linked', names: ['S'] })
        expect(links.get('deleted')).toEqual({ state: 'broken', names: ['D'] })
        expect(links.has('plain')).toBe(false)
    })

    test('a bot finds its own modules, and a module its bots (none in the trash)', () => {
        const modules = [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2', nodeOnlyPairedCharacterIds: ['a', 's', 'd'] }]
        expect(modulesOfBot({ modules: ['m2', 'gone', 'm1', 'm2'] }, modules).map((m) => m.id)).toEqual(['m2', 'm1'])
        expect(modulesOfBot(undefined, modules)).toEqual([])
        const characters = [null, { chaId: 'a', name: 'A', modules: ['m2'] }, { chaId: 't', name: 'T', modules: ['m2'], trashTime: 1 }]
        const archived = [{ chaId: 's', name: 'S' }, { chaId: 'd', name: 'D', trashedAt: 3 }, { chaId: 'x', name: 'X' }]
        expect(botsOfModule(modules[1], characters, archived)).toEqual([
            { chaId: 'a', name: 'A', index: 1, archived: false },
            { chaId: 's', name: 'S', index: -1, archived: true },
        ])
        expect(botsOfModule(modules[0], characters, archived)).toEqual([])
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

describe('linking a module again', () => {
    // The user's report, 2026-10-30: the new version of a deleted asset
    // module was linked and the bot's chain stayed red.
    test('drops the ids of deleted modules, so the chain turns green', () => {
        const modules = [{ id: 'new' }, { id: 'lore' }]
        const bot = { chaId: 'b', modules: ['old', 'lore', 'new'] }
        expect(characterModuleLink(bot, new Set(modules.map((m) => m.id)))).toBe('broken')
        expect(dropMissingBotModules(bot, modules)).toBe(true)
        expect(bot.modules).toEqual(['lore', 'new'])
        expect(characterModuleLink(bot, new Set(modules.map((m) => m.id)))).toBe('linked')
        expect(dropMissingBotModules(bot, modules)).toBe(false)
    })
})

describe('folderBotLinkChange', () => {
    test('links the folder modules the bot lacks, after its own', () => {
        expect(folderBotLinkChange(['x', 'a'], ['a', 'b', 'c'])).toEqual({ modules: ['x', 'a', 'b', 'c'], linked: ['b', 'c'], unlinked: [] })
        expect(folderBotLinkChange(undefined, ['a'])).toEqual({ modules: ['a'], linked: ['a'], unlinked: [] })
    })

    test('unlinks them all when the bot already has every one', () => {
        expect(folderBotLinkChange(['a', 'x', 'b'], ['b', 'a'])).toEqual({ modules: ['x'], linked: [], unlinked: ['b', 'a'] })
    })

    test('an empty folder changes nothing', () => {
        expect(folderBotLinkChange(['x'], [])).toEqual({ modules: ['x'], linked: [], unlinked: [] })
    })
})
