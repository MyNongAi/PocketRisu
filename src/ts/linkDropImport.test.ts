import { beforeEach, describe, expect, test, vi } from 'vitest'

const importCharacterLink = vi.fn(async (_url: string) => true)
const importModuleLink = vi.fn(async (_url: string) => true)
const openImportedCharacter = vi.fn()
const notifyWarning = vi.fn()
const BEFORE = new Set(['already-there'])

vi.mock('./characters', () => ({
    importCharacterLink: (url: string) => importCharacterLink(url),
    characterIdsNow: () => BEFORE,
    openImportedCharacter: (before: unknown) => openImportedCharacter(before),
}))
vi.mock('./process/modules', () => ({ importModuleLink: (url: string) => importModuleLink(url) }))
vi.mock('./alert', () => ({ notifyWarning: (msg: unknown) => notifyWarning(msg) }))
vi.mock('src/lang', () => ({ language: { linkDropUnsupported: 'unsupported link' } }))

const { importDroppedLink } = await import('./linkDropImport')

const realm = 'https://realm.risuai.net/character/0b8a4c55-3a63-4b8e-9c2c-1d3f5b2a7e10'

beforeEach(() => {
    importCharacterLink.mockClear().mockResolvedValue(true)
    importModuleLink.mockClear().mockResolvedValue(true)
    openImportedCharacter.mockClear()
    notifyWarning.mockClear()
})

describe('importDroppedLink', () => {
    test('anywhere in the app, the link imports as the bot Proton box imports it', async () => {
        await expect(importDroppedLink(realm, 'character')).resolves.toBe(true)
        expect(importCharacterLink).toHaveBeenCalledWith(realm)
        expect(importModuleLink).not.toHaveBeenCalled()
        expect(notifyWarning).not.toHaveBeenCalled()
    })

    test('the bot it brought is handed to the "go to the character on import" check, with the bots there before', async () => {
        await importDroppedLink(realm, 'character')
        expect(openImportedCharacter).toHaveBeenCalledWith(BEFORE)
    })

    test('on the module page, as that page\'s Proton box imports it', async () => {
        await expect(importDroppedLink(realm, 'module')).resolves.toBe(true)
        expect(importModuleLink).toHaveBeenCalledWith(realm)
        expect(importCharacterLink).not.toHaveBeenCalled()
        expect(openImportedCharacter).not.toHaveBeenCalled()
    })

    test('a link neither box can import says so, with no file picker', async () => {
        importCharacterLink.mockResolvedValue(false)
        await expect(importDroppedLink('https://example.com/page', 'character')).resolves.toBe(false)
        expect(notifyWarning).toHaveBeenCalledWith('unsupported link')
        expect(openImportedCharacter).not.toHaveBeenCalled()
    })
})
