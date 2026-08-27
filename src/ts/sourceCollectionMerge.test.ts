import { describe, expect, it } from 'vitest'
import {
    applySourceCollectionEntities,
    reconcileSourceCollectionModuleReferences,
    type SourceMergeDatabase,
} from './sourceCollectionMerge'

function db(): SourceMergeDatabase {
    return {
        characters: [{ name: 'existing', chaId: 'existing' }],
        characterOrder: ['existing'],
        modules: [],
        moduleFolders: [],
        personas: [],
    }
}

function ids() {
    let index = 0
    return () => `new-${++index}`
}

const blankCharacter = () => ({
    name: '',
    chaId: 'blank',
    chats: [{ name: 'Chat 1', message: [], note: '', localLore: [] }],
    chatFolders: [],
    chatPage: 0,
})

describe('applySourceCollectionEntities', () => {
    it('keeps duplicate character names, discards histories, and groups by source', () => {
        const target = db()
        const result = applySourceCollectionEntities(target, {
            kind: 'characters',
            sourceLabel: '모바일웹리스',
            bundleId: 'bundle-12345678',
            entities: [{ name: 'existing', chaId: 'old', chats: [{ message: ['history'] }] }],
            createId: ids(),
            createBlankCharacter: blankCharacter,
            importedAt: 10,
        })
        expect(result.characters).toBe(1)
        expect(target.characters).toHaveLength(2)
        expect(target.characters[1].chaId).not.toBe('old')
        expect(target.characters[1].chats[0].message).toEqual([])
        expect(target.characters[1].sourceInfo.label).toBe('모바일웹리스')
        expect(target.characterOrder[0]).toMatchObject({
            name: expect.stringContaining('[유사 후보]'),
            data: ['existing', target.characters[1].chaId],
        })
        expect(target.characterOrder).toContainEqual(expect.objectContaining({ name: '[출처] 모바일웹리스' }))
    })

    it('creates module folders without changing prior module order', () => {
        const target = db()
        target.modules.push({ id: 'old', name: 'old' })
        applySourceCollectionEntities(target, {
            kind: 'modules',
            sourceLabel: '로컬리스',
            bundleId: 'bundle-12345678',
            entities: [{ id: 'source-id', name: 'mod' }],
            createId: ids(),
            createBlankCharacter: blankCharacter,
        })
        expect(target.modules.map((module) => module.name)).toEqual(['old', 'mod'])
        expect(target.modules[1].id).not.toBe('source-id')
        expect(target.moduleFolders?.[0].moduleIds).toEqual([target.modules[1].id])
    })

    it('keeps persona duplicates and records visible provenance', () => {
        const target = db()
        target.personas.push({ id: 'old', name: 'Traveler', icon: '' })
        applySourceCollectionEntities(target, {
            kind: 'personas',
            sourceLabel: 'PC웹리스',
            bundleId: 'bundle-12345678',
            entities: [{ id: 'source', name: 'Traveler', icon: 'assets/p.png' }],
            createId: ids(),
            createBlankCharacter: blankCharacter,
            importedAt: 11,
        })
        expect(target.personas).toHaveLength(2)
        expect(target.personas[1].id).not.toBe('source')
        expect(target.personas[1].sourceInfo).toEqual({
            label: 'PC웹리스',
            bundleId: 'bundle-12345678',
            importedAt: 11,
        })
    })

    it('retries colliding ids instead of overwriting or reusing them', () => {
        const target = db()
        const candidates = ['existing', 'existing', 'fresh-character', 'fresh-folder']
        applySourceCollectionEntities(target, {
            kind: 'characters',
            sourceLabel: '로컬리스',
            bundleId: 'bundle-12345678',
            entities: [{ name: 'duplicate id source' }],
            createId: () => candidates.shift() ?? 'fallback',
            createBlankCharacter: blankCharacter,
        })
        expect(target.characters[1].chaId).toBe('fresh-character')
        expect(target.characterOrder[0]).toMatchObject({ id: 'fresh-folder' })
    })

    it('does not mistake a user folder with the same visible name for a source folder', () => {
        const target = db()
        target.characterOrder.unshift({
            id: 'user-folder',
            name: '[출처] 로컬리스',
            data: [],
            color: '',
        })
        applySourceCollectionEntities(target, {
            kind: 'characters',
            sourceLabel: '로컬리스',
            bundleId: 'bundle-12345678',
            entities: [{ name: 'imported' }],
            createId: ids(),
            createBlankCharacter: blankCharacter,
        })
        const folders = target.characterOrder.filter((entry) => typeof entry !== 'string')
        expect(folders).toHaveLength(2)
        expect(folders[0]).toMatchObject({
            name: '[출처] 로컬리스',
            sourceInfo: { label: '로컬리스' },
        })
        expect(folders[1]).toMatchObject({ id: 'user-folder', data: [] })
    })

    it('remaps character module ids without ever activating an unrelated target id', () => {
        const target = db()
        target.modules.push({ id: 'source-module', name: 'unrelated target module' })
        const moduleResult = applySourceCollectionEntities(target, {
            kind: 'modules',
            sourceLabel: '모바일웹리스',
            bundleId: 'module-bundle-123',
            collectionId: 'collection-12345678',
            entities: [{ id: 'source-module', name: 'related source module' }],
            createId: ids(),
            createBlankCharacter: blankCharacter,
        })
        const importedModuleId = moduleResult.moduleIdMap.get('source-module')!
        expect(importedModuleId).not.toBe('source-module')

        const result = applySourceCollectionEntities(target, {
            kind: 'characters',
            sourceLabel: '모바일웹리스',
            bundleId: 'character-bundle-1',
            collectionId: 'collection-12345678',
            entities: [{ name: 'linked bot', modules: ['source-module', 'missing-module'] }],
            moduleIdMapping: moduleResult.moduleIdMap,
            createId: ids(),
            createBlankCharacter: blankCharacter,
        })
        const character = target.characters.at(-1)!
        expect(character.modules).toEqual([importedModuleId])
        expect(character.modules).not.toContain('source-module')
        expect(character.sourceInfo.originalModuleIds).toEqual(['source-module', 'missing-module'])
        expect(result.droppedModuleReferences).toBe(1)
    })

    it('keeps unresolved ids pending and reconnects only the exact collection later', () => {
        const target = db()
        target.modules.push({ id: 'source-module', name: 'unrelated target module' })
        applySourceCollectionEntities(target, {
            kind: 'characters',
            sourceLabel: '모바일웹리스',
            bundleId: 'character-bundle-1',
            collectionId: 'collection-A-1234',
            entities: [{ name: 'pending bot', modules: ['source-module'] }],
            createId: ids(),
            createBlankCharacter: blankCharacter,
        })
        const character = target.characters.at(-1)!
        expect(character.modules).toEqual([])

        expect(reconcileSourceCollectionModuleReferences(
            target,
            'collection-B-1234',
            new Map([['source-module', 'wrong-new-id']]),
        )).toBe(0)
        expect(character.modules).toEqual([])

        expect(reconcileSourceCollectionModuleReferences(
            target,
            'collection-A-1234',
            new Map([['source-module', 'right-new-id']]),
        )).toBe(1)
        expect(character.modules).toEqual(['right-new-id'])
    })

    it('collects imported module duplicates in a review folder without deleting either module', () => {
        const target = db()
        applySourceCollectionEntities(target, {
            kind: 'modules',
            sourceLabel: '웹리스',
            bundleId: 'web-bundle',
            entities: [{ id: 'web-id', name: 'Nahida Module' }],
            createId: ids(),
            createBlankCharacter: blankCharacter,
        })
        applySourceCollectionEntities(target, {
            kind: 'modules',
            sourceLabel: '모바일웹리스',
            bundleId: 'mobile-bundle',
            entities: [{ id: 'mobile-id', name: 'nahida-module' }],
            createId: ids(),
            createBlankCharacter: blankCharacter,
        })

        expect(target.modules).toHaveLength(2)
        expect(target.moduleFolders?.[0]).toMatchObject({
            name: expect.stringContaining('[유사 후보]'),
            moduleIds: target.modules.map((module) => module.id),
        })
    })
})
