import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    db: {
        characters: [{ name: 'existing', chaId: 'existing' }] as any[],
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

import { SOURCE_COLLECTION_FORMAT, SOURCE_COLLECTION_MAX_ASSET_BYTES } from './sourceCollection'
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

function relatedCollectionFile(options: {
    bundleId: string
    collectionId: string
    kind: 'characters' | 'modules'
    entities: unknown[]
}): File {
    return new File([JSON.stringify({
        format: SOURCE_COLLECTION_FORMAT,
        version: 1,
        bundleId: options.bundleId,
        collectionId: options.collectionId,
        kind: options.kind,
        sourceLabel: '모바일웹리스',
        createdAt: 456,
        partIndex: 0,
        last: true,
        entities: options.entities,
        assets: [],
        omittedAssets: [],
    })], `${options.bundleId}.${options.kind === 'modules' ? 'risu-modules' : 'risu-characters'}`, {
        type: 'application/json',
    })
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

    it('maps modules before characters regardless of file-picker order and ignores an unrelated colliding id', async () => {
        mocks.db.modules = [{ id: 'old-module', name: 'unrelated target module' }]
        const characterFile = relatedCollectionFile({
            bundleId: 'character-bundle-123',
            collectionId: 'collection-alpha-123',
            kind: 'characters',
            entities: [{ name: 'linked bot', modules: ['old-module'] }],
        })
        const moduleFile = relatedCollectionFile({
            bundleId: 'module-bundle-12345',
            collectionId: 'collection-alpha-123',
            kind: 'modules',
            entities: [{ id: 'old-module', name: 'source module' }],
        })

        await importSourceCollectionFiles([characterFile, moduleFile])

        const importedModule = mocks.db.modules.find((module) => module.name === 'source module')!
        const importedCharacter = mocks.db.characters.find((character) => character.name === 'linked bot')!
        expect(importedModule.id).not.toBe('old-module')
        expect(importedCharacter.modules).toEqual([importedModule.id])
        expect(importedCharacter.sourceInfo.originalModuleIds).toEqual(['old-module'])
    })

    it('reconnects a character-only import when its exact module collection arrives later', async () => {
        mocks.db.modules = [{ id: 'old-module', name: 'unrelated target module' }]
        await importSourceCollectionFiles([relatedCollectionFile({
            bundleId: 'character-bundle-456',
            collectionId: 'collection-later-123',
            kind: 'characters',
            entities: [{ name: 'pending bot', modules: ['old-module'] }],
        })])
        const importedCharacter = mocks.db.characters.find((character) => character.name === 'pending bot')!
        expect(importedCharacter.modules).toEqual([])
        expect(importedCharacter.sourceInfo.originalModuleIds).toEqual(['old-module'])

        // A different collection with the same old id must not attach.
        await importSourceCollectionFiles([relatedCollectionFile({
            bundleId: 'module-bundle-wrong',
            collectionId: 'collection-other-12',
            kind: 'modules',
            entities: [{ id: 'old-module', name: 'wrong collection module' }],
        })])
        expect(importedCharacter.modules).toEqual([])

        await importSourceCollectionFiles([relatedCollectionFile({
            bundleId: 'module-bundle-right',
            collectionId: 'collection-later-123',
            kind: 'modules',
            entities: [{ id: 'old-module', name: 'right collection module' }],
        })])
        const rightModule = mocks.db.modules.find((module) => module.name === 'right collection module')!
        expect(importedCharacter.modules).toEqual([rightModule.id])
        expect(importedCharacter.modules).not.toContain('old-module')

        // Two candidates carrying the same source id are deliberately treated
        // as ambiguous rather than choosing one by array order.
        await importSourceCollectionFiles([relatedCollectionFile({
            bundleId: 'module-bundle-ambig',
            collectionId: 'collection-later-123',
            kind: 'modules',
            entities: [{ id: 'old-module', name: 'second same-source module' }],
        })])
        expect(importedCharacter.modules).toEqual([])
    })

    it('imports the rest of a collection while clearing a manifest-recorded oversized asset', async () => {
        const file = new File([JSON.stringify({
            format: SOURCE_COLLECTION_FORMAT,
            version: 1,
            bundleId: 'bundle-omitted-123',
            kind: 'characters',
            sourceLabel: '모바일웹리스',
            createdAt: 789,
            partIndex: 0,
            last: true,
            entities: [{ name: 'large icon bot', image: 'assets/large.png' }],
            assets: [],
            omittedAssets: [{
                path: 'assets/large.png',
                size: SOURCE_COLLECTION_MAX_ASSET_BYTES + 1,
                reason: 'too-large',
            }],
        })], 'omitted.risu-characters', { type: 'application/json' })

        const summary = await importSourceCollectionFiles([file])

        expect(summary.omittedAssets).toBe(1)
        expect(mocks.saveAsset).not.toHaveBeenCalled()
        expect(mocks.db.characters.find((character) => character.name === 'large icon bot')?.image).toBe('')
    })

    it('rolls back a late-save failure after temporarily reconnecting an older character', async () => {
        const pending = {
            name: 'pending',
            chaId: 'pending',
            modules: [],
            sourceInfo: {
                label: '모바일웹리스',
                bundleId: 'old-character-bundle',
                collectionId: 'collection-rollback-1',
                importedAt: 1,
                originalModuleIds: ['old-module'],
            },
        }
        mocks.db.characters = [mocks.db.characters[0], pending]
        mocks.db.characterOrder = ['existing', 'pending']
        mocks.requestImmediateSave.mockRejectedValueOnce(new Error('save failed'))

        await expect(importSourceCollectionFiles([relatedCollectionFile({
            bundleId: 'module-rollback-123',
            collectionId: 'collection-rollback-1',
            kind: 'modules',
            entities: [{ id: 'old-module', name: 'rollback module' }],
        })])).rejects.toThrow(/save failed/)

        expect(pending.modules).toEqual([])
        expect(mocks.db.modules).toEqual([])
        expect(mocks.db.characters).toContain(pending)
    })
})
