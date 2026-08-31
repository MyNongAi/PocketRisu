import { describe, expect, it } from 'vitest'
import {
    organizeAllSimilarityFolders,
    organizeImportedCharacterSimilarity,
    organizeImportedModuleSimilarity,
    type SimilarityFolderDatabase,
} from './similarityFolders'

function ids(){
    let value = 0
    return () => `folder-${++value}`
}

function database(): SimilarityFolderDatabase {
    return {
        characters: [
            { chaId: 'c1', name: 'Nahida Desktop' },
            { chaId: 'c2', name: 'nahida-desktop' },
            { chaId: 'c3', name: 'Unrelated' },
        ],
        characterOrder: ['c3', 'c1', 'c2'],
        modules: [
            { id: 'm1', name: 'Asset Module v1' },
            { id: 'm2', name: 'asset-module-v1' },
            { id: 'm3', name: 'Other Module' },
        ],
        moduleFolders: [],
        moduleActivationHistory: ['m1', 'm2', 'm3'],
    }
}

describe('similarity candidate folders', () => {
    it('groups pre-existing character and module matches at the top without deleting items', () => {
        const db = database()
        organizeAllSimilarityFolders(db, ids())

        expect(db.characters).toHaveLength(3)
        expect(db.modules).toHaveLength(3)
        expect(db.characterOrder[0]).toMatchObject({
            name: expect.stringContaining('[유사 후보]'),
            data: ['c1', 'c2'],
        })
        expect(db.moduleFolders?.[0]).toMatchObject({
            name: expect.stringContaining('[유사 후보]'),
        })
        expect(db.modules.filter((module) => module.folderId).map((module) => module.id)).toEqual(['m1', 'm2'])
        expect(db.modules[0].folderId).toBe(db.moduleFolders?.[0].id)
    })

    it('moves only a newly matched component into a top review folder', () => {
        const db = database()
        db.characters = [
            { chaId: 'old', name: 'Alice Card' },
            { chaId: 'new', name: 'alice-card' },
            { chaId: 'safe', name: 'Bob Card' },
        ]
        db.characterOrder = ['safe', 'old', 'new']

        organizeImportedCharacterSimilarity(db, 'new', ids())

        expect(db.characterOrder[0]).toMatchObject({ data: ['old', 'new'] })
        expect(db.characterOrder).toContain('safe')
    })

    it('keeps a new unrelated module at root and groups a later match', () => {
        const db = database()
        db.modules = [{ id: 'base', name: 'Unique Module' }]
        db.moduleFolders = []
        organizeImportedModuleSimilarity(db, 'base', ids())
        expect(db.moduleFolders).toEqual([])

        db.modules.push({ id: 'copy', name: 'unique-module' })
        organizeImportedModuleSimilarity(db, 'copy', ids())
        expect(db.modules.map((module) => module.folderId)).toEqual([
            db.moduleFolders?.[0].id,
            db.moduleFolders?.[0].id,
        ])
    })

    it('requires exact normalized equality for short names', () => {
        const db = database()
        db.characters = [
            { chaId: 'a', name: '유나' },
            { chaId: 'b', name: '유라' },
        ]
        db.characterOrder = ['a', 'b']
        organizeAllSimilarityFolders(db, ids())
        expect(db.characterOrder).toEqual(['a', 'b'])
    })

    it('returns members of an obsolete generated folder to the root order', () => {
        const db = database()
        db.characters = [
            { chaId: 'a', name: 'Alpha' },
            { chaId: 'b', name: 'Beta' },
        ]
        db.characterOrder = [{
            id: 'old-folder',
            name: '[유사 후보] old',
            data: ['a', 'b'],
            color: 'yellow',
            duplicateCandidate: { kind: 'character', key: 'old' },
        }]

        organizeAllSimilarityFolders(db, ids())

        expect(db.characterOrder).toEqual(['a', 'b'])
    })

    it('reuses an incremental character folder id without duplicating stale members', () => {
        const db = database()
        db.characters = [
            { chaId: 'old', name: 'No Longer Similar' },
            { chaId: 'base', name: 'Alice Card' },
            { chaId: 'new', name: 'alice-card' },
        ]
        db.characterOrder = [{
            id: 'candidate-folder',
            name: '[유사 후보] old',
            data: ['old', 'base'],
            color: 'yellow',
            duplicateCandidate: { kind: 'character', key: 'old' },
        }, 'new']

        organizeImportedCharacterSimilarity(db, 'new', ids())

        expect(db.characterOrder[0]).toMatchObject({
            id: 'candidate-folder',
            data: ['base', 'new'],
        })
        expect(db.characterOrder).toEqual(expect.arrayContaining(['old']))
        expect(db.characterOrder.filter((entry) => typeof entry !== 'string' && entry.id === 'candidate-folder')).toHaveLength(1)
    })

    it('reuses an incremental module folder id without duplicating it', () => {
        const db = database()
        db.modules = [
            { id: 'old', name: 'No Longer Similar', folderId: 'candidate-folder' },
            { id: 'base', name: 'Alice Module', folderId: 'candidate-folder' },
            { id: 'new', name: 'alice-module' },
        ]
        db.moduleFolders = [{
            id: 'candidate-folder',
            name: '[유사 후보] old',
            duplicateCandidate: { kind: 'module', key: 'old' },
        }]

        organizeImportedModuleSimilarity(db, 'new', ids())

        expect(db.moduleFolders?.[0]).toMatchObject({
            id: 'candidate-folder',
        })
        expect(db.modules.find((module) => module.id === 'old')?.folderId).toBeUndefined()
        expect(db.modules.find((module) => module.id === 'base')?.folderId).toBe('candidate-folder')
        expect(db.modules.find((module) => module.id === 'new')?.folderId).toBe('candidate-folder')
        expect(db.moduleFolders?.filter((folder) => folder.id === 'candidate-folder')).toHaveLength(1)
    })
})
