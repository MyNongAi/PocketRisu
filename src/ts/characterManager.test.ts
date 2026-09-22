import { describe, expect, it } from 'vitest'
import { buildManagerEntries } from './characterManager'
import type { Database } from './storage/database.svelte'

describe('character manager metadata', () => {
    it('carries source and missing-asset health into active rows', () => {
        const db = {
            characters: [{
                chaId: 'mobile',
                name: 'Mobile card',
                image: 'assets/a',
                chats: [],
                titleColor: '#4ade80',
                sourceInfo: {
                    label: '모바일웹리스',
                    missingAssetCount: 3,
                    assetReferenceCount: 9,
                    realmAssetRecoveryAvailable: true,
                },
            }],
            nodeOnlyHiddenCharacterIds: [],
            nodeOnlyArchivedCharacters: [],
        } as unknown as Database

        expect(buildManagerEntries(db).get('mobile')).toMatchObject({
            sourceBadge: '모바일',
            sourceRecorded: true,
            missingAssetCount: 3,
            assetCount: 9,
            realmRecoveryAvailable: true,
            titleColor: '#4ade80',
        })
    })

    it('keeps archived source and health metadata and labels legacy baseline rows', () => {
        const db = {
            characters: [],
            nodeOnlyArchivedCharacters: [{
                chaId: 'local-cold', name: 'Local', image: '', chatCount: 0,
                lastInteraction: 0, archivedAt: 1, bytes: 1, chatIds: [], tags: [],
                sourceInfo: { label: '로컬리스', missingAssetCount: 1 },
            }, {
                chaId: 'legacy', name: 'Legacy', image: '', chatCount: 0,
                lastInteraction: 0, archivedAt: 1, bytes: 1, chatIds: [], tags: [],
            }],
        } as unknown as Database

        const entries = buildManagerEntries(db)
        expect(entries.get('local-cold')).toMatchObject({
            sourceBadge: '로컬', sourceRecorded: true, missingAssetCount: 1,
        })
        expect(entries.get('legacy')).toMatchObject({
            sourceBadge: '웹', sourceRecorded: false, missingAssetCount: 0,
        })
    })
})

describe('import date on manager rows', () => {
    // creation_date belongs to the card's author and a freshly downloaded card
    // can carry one from years back, so the row has to read the local field.
    it('prefers the local import date over the card-authored creation date', () => {
        const db = {
            characters: [{
                chaId: 'local',
                name: 'Imported today',
                chats: [],
                creation_date: 1_000_000,
                importedAt: 1_790_000_000_000,
            }],
            nodeOnlyHiddenCharacterIds: [],
            nodeOnlyArchivedCharacters: [],
        } as unknown as Database

        expect(buildManagerEntries(db).get('local')).toMatchObject({
            importedAt: 1_790_000_000_000,
            creationDate: 1_000_000,
        })
    })

    it('falls back to a collection import stamp, then to zero', () => {
        const db = {
            characters: [
                { chaId: 'collection', name: 'From bundle', chats: [], sourceInfo: { label: 'x', importedAt: 42 } },
                { chaId: 'legacy', name: 'Predates the field', chats: [] },
            ],
            nodeOnlyHiddenCharacterIds: [],
            nodeOnlyArchivedCharacters: [],
        } as unknown as Database

        const entries = buildManagerEntries(db)
        expect(entries.get('collection')?.importedAt).toBe(42)
        expect(entries.get('legacy')?.importedAt).toBe(0)
    })

    it('carries the import date onto archived stubs too', () => {
        const db = {
            characters: [],
            nodeOnlyHiddenCharacterIds: [],
            nodeOnlyArchivedCharacters: [
                { chaId: 'archived', name: 'Deactivated', importedAt: 777 },
            ],
        } as unknown as Database

        expect(buildManagerEntries(db).get('archived')?.importedAt).toBe(777)
    })
})
