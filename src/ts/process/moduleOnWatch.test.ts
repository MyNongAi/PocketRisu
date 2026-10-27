import { describe, expect, it, vi } from 'vitest'

vi.mock('../stores.svelte', () => ({ DBState: { db: undefined }, selIdState: { selId: 0 } }))

import { liftModulesTurnedOn, modulesOnNow, modulesTurnedOn, type ModuleOnDb } from './moduleOnWatch.svelte'
import { sortModulesByActivation } from './moduleSort'

const db = (): ModuleOnDb => ({
    modules: [
        { id: 'global', name: 'global' },
        { id: 'chat', name: 'chat' },
        { id: 'bot', name: 'bot', folderId: 'linked' },
        { id: 'preset', name: 'preset', namespace: 'np' },
        { id: 'other', name: 'other' },
    ],
    moduleFolders: [{ id: 'linked', moduleIds: ['bot'] }],
    enabledModules: ['global'],
    moduleIntergration: 'np, missing',
    moduleActivationHistory: ['bot', 'preset', 'chat', 'other', 'global'],
    characters: [
        { modules: [], chats: [{}], chatPage: 0 },
        { modules: ['bot'], chats: [{ modules: [] }, { modules: ['chat'] }], chatPage: 1 },
    ],
})

describe('modulesOnNow', () => {
    it('gathers the blue and the orange ones for the open chat', () => {
        expect(modulesOnNow(db(), 1)).toEqual(['global', 'chat', 'bot', 'preset'])
        expect(modulesOnNow({ ...db(), moduleIntergration: '' }, 0)).toEqual(['global'])
    })
})

describe('modulesTurnedOn', () => {
    it('finds what came on, in the order it is on', () => {
        expect(modulesTurnedOn(['global'], ['global', 'chat', 'bot'])).toEqual(['chat', 'bot'])
        expect(modulesTurnedOn(['global', 'bot'], ['global'])).toEqual([])
    })
})

describe('liftModulesTurnedOn', () => {
    it('puts what came on at the top of 최근순, the first one newest', () => {
        const state = db()
        const before = sortModulesByActivation(state.modules, '', { fallbackOrders: [state.enabledModules], activationHistory: state.moduleActivationHistory }).map((module) => module.id)
        expect(before.slice(0, 2)).toEqual(['global', 'other'])
        liftModulesTurnedOn(state, ['bot', 'preset', 'gone'])
        const after = sortModulesByActivation(state.modules, '', { fallbackOrders: [state.enabledModules], activationHistory: state.moduleActivationHistory }).map((module) => module.id)
        expect(after.slice(0, 2)).toEqual(['bot', 'preset'])
        expect(state.moduleActivationHistory).not.toContain('gone')
    })
})
