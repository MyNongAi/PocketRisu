import { describe, expect, test } from 'vitest'
import { classifySharedImport, importableAsEither } from './shareTargetRouting'

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

    test('the prompt preset page reads a .json or .preset as a preset', () => {
        expect(classifySharedImport('my-preset.json', 'application/json', 'preset')).toBe('preset')
        expect(classifySharedImport('old.preset', '', 'preset')).toBe('preset')
        expect(classifySharedImport('model.risupreset', '', 'preset')).toBe('preset')
        // Elsewhere a .json stays a character card.
        expect(classifySharedImport('my-preset.json', 'application/json', 'character')).toBe('character')
    })

    test('unrelated shared files are rejected', () => {
        expect(classifySharedImport('archive.zip', 'application/zip')).toBeNull()
        expect(classifySharedImport('notes.txt', 'text/plain')).toBeNull()
    })
})

describe('files either importer reads (the Proton browser override menu)', () => {
    test('a .charx or .json is either, a module export or another type is not', () => {
        expect(importableAsEither('Heroine.charx')).toBe(true)
        expect(importableAsEither('card.JSON')).toBe(true)
        expect(importableAsEither('Heroine.module.charx')).toBe(false)
        expect(importableAsEither('extra.risum')).toBe(false)
        expect(importableAsEither('card.png')).toBe(false)
        // The import choice decides those: the same file reads as each.
        expect(classifySharedImport('Heroine.charx', '', 'character')).toBe('character')
        expect(classifySharedImport('Heroine.charx', '', 'module')).toBe('module')
    })
})
