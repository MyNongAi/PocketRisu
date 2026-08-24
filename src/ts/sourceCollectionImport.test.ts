import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    db: {
        characters: [{ name: 'existing', chaId: 'existing' }],
        characterOrder: ['existing'] as any[],
        modules: [] as any[],
        moduleFolders: [] as any[],
        personas: [] as any[],
    },
    createBlankCharacter: vi.fn(),
    requestImmediateSave: vi.fn(async () => undefined),
    saveAsset: vi.fn(),
    refreshModules: vi.fn(),
}))

vi.mock('uuid', () => ({
    v4: vi.fn(() => crypto.randomUUID()),
}))

vi.mock(import('./alert'), () => ({
    alertError: vi.fn(),
    alertWait: vi.fn(),
    notifySuccess: vi.fn(),
} as any))

vi.mock(import('./characters'), () => ({
    createBlankChar: mocks.createBlankCharacter,
} as any))

vi.mock(import('./globalApi.svelte'), () => ({
    checkCharOrder: vi.fn(),
    requestImmediateSave: mocks.requestImmediateSave,
    saveAsset: mocks.saveAsset,
} as any))

vi.mock(import('./process/modules'), () => ({
    refreshModules: mocks.refreshModules,
} as any))

vi.mock(import('./storage/database.svelte'), () => ({
    getDatabase: () => mocks.db,
} as any))

import { SOURCE_COLLECTION_FORMAT } from './sourceCollection'
import { importSourceCollectionFiles } from './sourceCollectionImport'

function collectionFile(bundleId: string, name: string, partIndex = 0, last = true): File {
    return new File([JSON.stringify({
        format: SOURCE_COLLECTION_FORMAT,
        version: 1,
        bundleId,
        kind: 'characters',
        sourceLabel: '모바일웹리스',
        createdAt: 123,
        partIndex,
        last,
        entities: [{ name }],
        assets: [],
    })], `${bundleId}-${partIndex}.risu-characters`, { type: 'application/json' })
}

function blankCharacter() {
    return {
        name: '',
        chaId: 'blank',
        chats: [{ name: 'Chat 1', message: [], note: '', localLore: [] }],
        chatFolders: [],
        chatPage: 0,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.db.characters = [{ name: 'existing', chaId: 'existing' }]
    mocks.db.characterOrder = ['existing']
    mocks.db.modules = []
    mocks.db.moduleFolders = []
    mocks.db.personas = []
    mocks.createBlankCharacter.mockImplementation(blankCharacter)
})

describe('source collection import transaction', () => {
    it('rejects an empty selection without scheduling a save', async () => {
        await expect(importSourceCollectionFiles([])).rejects.toThrow(/No collection parts/)
        expect(mocks.requestImmediateSave).not.toHaveBeenCalled()
    })

    it('restores all collection arrays when a later bundle fails during merge', async () => {
        mocks.createBlankCharacter
            .mockImplementationOnce(blankCharacter)
            .mockImplementationOnce(() => { throw new Error('second bundle failed') })

        await expect(importSourceCollectionFiles([
            collectionFile('bundle-first-1234', 'first'),
            collectionFile('bundle-second-123', 'second'),
        ])).rejects.toThrow(/second bundle failed/)

        expect(mocks.db.characters).toEqual([{ name: 'existing', chaId: 'existing' }])
        expect(mocks.db.characterOrder).toEqual(['existing'])
        expect(mocks.db.modules).toEqual([])
        expect(mocks.db.moduleFolders).toEqual([])
        expect(mocks.db.personas).toEqual([])
        expect(mocks.requestImmediateSave).not.toHaveBeenCalled()
    })

    it('rejects an incomplete bundle before touching database state', async () => {
        await expect(importSourceCollectionFiles([
            collectionFile('bundle-missing-123', 'missing', 1, true),
        ])).rejects.toThrow(/missing or duplicated/)
        expect(mocks.db.characters).toEqual([{ name: 'existing', chaId: 'existing' }])
        expect(mocks.createBlankCharacter).not.toHaveBeenCalled()
    })
})
