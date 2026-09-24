import { describe, expect, test } from 'vitest'
import { classifySharedImport } from './shareTargetRouting'

describe('PWA share target import routing', () => {
    test.each([
        ['character.charx', '', 'character'],
        ['embedded.png', 'image/png', 'character'],
        ['legacy.jpg', 'image/jpeg', 'character'],
        ['world.risum', 'application/octet-stream', 'module'],
        ['world.lorebook', 'application/json', 'module'],
        ['model.risup', 'application/octet-stream', 'preset'],
        ['model.risupreset', 'application/octet-stream', 'preset'],
        ['card-without-extension', 'image/png', 'character'],
    ] as const)('%s routes to %s', (name, type, expected) => {
        expect(classifySharedImport(name, type)).toBe(expected)
    })

    test('a module exported as a card is a module wherever it is opened', () => {
        expect(classifySharedImport('World.module.charx')).toBe('module')
        expect(classifySharedImport('World.MODULE.CHARX', '', 'character')).toBe('module')
    })

    test('the module page reads any .charx or .json as a module', () => {
        expect(classifySharedImport('world.charx', '', 'module')).toBe('module')
        expect(classifySharedImport('lorebook.json', 'application/json', 'module')).toBe('module')
        expect(classifySharedImport('world.charx', '', 'character')).toBe('character')
        // Images and presets have only one importer, whichever page opened them.
        expect(classifySharedImport('card.png', 'image/png', 'module')).toBe('character')
        expect(classifySharedImport('model.risup', '', 'module')).toBe('preset')
    })

    test('unrelated shared files are rejected', () => {
        expect(classifySharedImport('archive.zip', 'application/zip')).toBeNull()
        expect(classifySharedImport('notes.txt', 'text/plain')).toBeNull()
    })
})
