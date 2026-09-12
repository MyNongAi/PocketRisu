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

    test('unrelated shared files are rejected', () => {
        expect(classifySharedImport('archive.zip', 'application/zip')).toBeNull()
        expect(classifySharedImport('notes.txt', 'text/plain')).toBeNull()
    })
})
