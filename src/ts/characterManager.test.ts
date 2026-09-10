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
