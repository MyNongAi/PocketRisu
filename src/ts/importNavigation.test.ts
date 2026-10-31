import { describe, expect, test } from 'vitest'
import { characterIdsBefore, characterToOpenAfterImport } from './importNavigation'

const bots = (...ids: string[]) => ids.map((chaId) => ({ chaId }))

describe('characterToOpenAfterImport', () => {
    test('with the toggle on, the bot the import added, the newest of several', () => {
        const before = characterIdsBefore(bots('a', 'b'))
        expect(characterToOpenAfterImport(bots('a', 'b', 'c'), before, true)).toBe(2)
        expect(characterToOpenAfterImport(bots('a', 'b', 'c', 'd'), before, true)).toBe(3)
    })

    test('with the toggle off, nothing opens', () => {
        const before = characterIdsBefore(bots('a'))
        expect(characterToOpenAfterImport(bots('a', 'b'), before, false)).toBe(-1)
    })

    test('a cancelled or failed import opens no bot, not the last one in the list', () => {
        const before = characterIdsBefore(bots('a', 'b'))
        expect(characterToOpenAfterImport(bots('a', 'b'), before, true)).toBe(-1)
    })

    test('a bot added anywhere in the list is found, and gaps are skipped', () => {
        const before = characterIdsBefore([...bots('a'), null, ...bots('b')])
        expect(characterToOpenAfterImport([...bots('a', 'new'), null, ...bots('b')], before, true)).toBe(1)
    })
})
