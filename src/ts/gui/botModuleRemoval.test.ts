import { describe, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'

vi.mock('../stores.svelte', () => ({ DBState: { db: {} }, selectedCharID: writable(-1) }))
vi.mock('../platform', () => ({ isNodeServer: true }))

const { splitBotModules } = await import('./botModuleRemoval')

const mod = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, description: '', ...extra })

describe('splitBotModules', () => {
    it('deletes only what nothing else turns on or remembers', () => {
        const db = {
            enabledModules: ['global'],
            moduleIntergration: '',
            botPresets: [{ moduleIntergration: 'presetNs' }],
            characters: [
                { chaId: 'me', modules: ['mine', 'global', 'other-bot', 'preset', 'other-chat', 'asleep', 'gone'], chats: [{ modules: ['mine'] }] },
                { chaId: 'b', modules: ['other-bot'], chats: [{ modules: ['other-chat'] }] },
            ],
            nodeOnlyArchivedCharacters: [{ chaId: 'z' }],
            modules: [
                mod('mine', { nodeOnlyPairedCharacterIds: ['me'] }),
                mod('global'),
                mod('other-bot'),
                mod('preset', { namespace: 'presetNs' }),
                mod('other-chat'),
                mod('asleep', { nodeOnlyPairedCharacterIds: ['me', 'z'] }),
            ],
        }
        const { only, shared } = splitBotModules(db, 'me')
        expect(only.map((m) => m.id)).toEqual(['mine'])
        expect(shared.map((m) => m.id)).toEqual(['global', 'other-bot', 'preset', 'other-chat', 'asleep'])
    })

    it('has nothing for a bot without linked modules', () => {
        expect(splitBotModules({ characters: [{ chaId: 'me' }], modules: [mod('x')] }, 'me')).toEqual({ only: [], shared: [] })
    })
})
