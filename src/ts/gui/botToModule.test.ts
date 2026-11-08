import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    db: { characters: [] as any[] },
    added: [] as any[],
    success: vi.fn(),
    error: vi.fn(),
    alertError: vi.fn(),
    hydrate: vi.fn(async (c: any) => c),
}))
vi.mock('src/lang', () => ({ language: { botToModuleGroup: 'group', botToModuleDone: "made '{}'" } }))
vi.mock('src/ts/alert', () => ({ alertError: mocks.alertError, notifyError: mocks.error, notifySuccess: mocks.success }))
vi.mock('src/ts/characterCards', () => ({ hydrateCharacterAssets: mocks.hydrate }))
vi.mock('src/ts/characters', () => ({ createBlankChar: () => ({}) }))
vi.mock('src/ts/process/modules', () => ({ addModuleToDatabase: (m: any) => mocks.added.push(m) }))
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => mocks.db }))

import { convertBotToModule } from './botToModule'

const bot = (over: Record<string, unknown> = {}) => ({
    type: 'character', chaId: 'b1', name: 'Mia', desc: 'desc', firstMessage: 'hi',
    globalLore: [{ key: 'k', content: 'lore', comment: 'one' }], customscript: [], triggerscript: [],
    image: 'img', ...over,
})

beforeEach(() => {
    mocks.db.characters = []
    mocks.added.length = 0
    mocks.success.mockClear()
    mocks.error.mockClear()
    mocks.alertError.mockClear()
    mocks.hydrate.mockClear()
    mocks.hydrate.mockImplementation(async (c: any) => c)
})

describe('a bot dropped on the Module tab (2026-11-08)', () => {
    it('adds a module made from the bot and leaves the bot as it is', async () => {
        const char = bot()
        mocks.db.characters = [bot({ chaId: 'other', name: 'Other' }), char]
        const module = await convertBotToModule('b1')
        expect(mocks.added).toEqual([module])
        expect(module?.name).toBe('Mia')
        expect(module?.icon).toBe('img')
        // The description and first message come along as lore, the bot's lore untouched.
        expect(module?.lorebook?.map((l) => l.comment)).toEqual(['one', 'From Character Description', 'From First Messages'])
        expect(char.globalLore).toHaveLength(1)
        expect(mocks.db.characters).toHaveLength(2)
        expect(mocks.hydrate).toHaveBeenCalledWith(char)
        expect(mocks.success).toHaveBeenCalledWith("made 'Mia'")
    })

    it('says a group chat cannot be one, and adds nothing', async () => {
        mocks.db.characters = [bot({ type: 'group' })]
        expect(await convertBotToModule('b1')).toBeNull()
        expect(mocks.added).toEqual([])
        expect(mocks.error).toHaveBeenCalledWith('group')
    })

    it('does nothing for a bot that is gone', async () => {
        expect(await convertBotToModule('gone')).toBeNull()
        expect(await convertBotToModule('')).toBeNull()
        expect(mocks.added).toEqual([])
        expect(mocks.error).not.toHaveBeenCalled()
    })

    it('makes one module from a double drop while the first is still loading assets', async () => {
        mocks.db.characters = [bot()]
        let release!: () => void
        mocks.hydrate.mockImplementationOnce((c: any) => new Promise((r) => { release = () => r(c) }))
        const first = convertBotToModule('b1')
        expect(await convertBotToModule('b1')).toBeNull()
        release()
        await first
        expect(mocks.added).toHaveLength(1)
        // Once done, the same bot can be dropped again.
        await convertBotToModule('b1')
        expect(mocks.added).toHaveLength(2)
    })

    it('shows the error when the assets cannot be read', async () => {
        mocks.db.characters = [bot()]
        mocks.hydrate.mockRejectedValueOnce(new Error('no asset'))
        expect(await convertBotToModule('b1')).toBeNull()
        expect(mocks.added).toEqual([])
        expect(mocks.alertError).toHaveBeenCalledWith('Error: no asset')
    })
})
