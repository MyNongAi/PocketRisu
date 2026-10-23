import { describe, expect, it } from 'vitest'
import { buildGridSections, buildManagerEntries, folderNameMatchIds, gridDropTarget, type ManagerEntry } from './characterManager'
import { moveSidebarItem } from '../lib/SideBars/sidebarDrag'
import type { OrderEntry } from './characterOrder'
import { DEACTIVATED_FOLDER_IDS } from './deactivatedCharacterFolders'
import type { Database, folder } from './storage/database.svelte'

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

describe('folder-name search in the manager', () => {
    const similar: folder = { id: 'sim', name: '[유사 후보]', color: '', data: ['a', 'b'] }
    const other: folder = { id: 'other', name: '판타지', color: '', data: ['c'] }
    const idle: folder = { id: DEACTIVATED_FOLDER_IDS[60], name: '비활성 60일', color: '', data: ['d'], nodeOnlySystem: 'deactivated' }
    const order = ['loose', similar, other, idle]

    it('shows every character of a folder whose name matches', () => {
        expect([...folderNameMatchIds(order, '유사')]).toEqual(['a', 'b'])
    })

    it('never matches an idle-age folder by its name', () => {
        expect(folderNameMatchIds(order, '비활성').size).toBe(0)
    })

    it('matches nothing without a search', () => {
        expect(folderNameMatchIds(order, '').size).toBe(0)
    })
})

function entry(chaId: string, extra: Partial<ManagerEntry> = {}): ManagerEntry {
    return {
        chaId, index: 0, name: chaId, image: '', chatCount: 0, lastInteraction: 0, creationDate: 0,
        assetCount: 0, sourceBadge: '웹', sourceRecorded: false, missingAssetCount: 0, realmRecoveryAvailable: false, importedAt: 0,
        archived: false, hidden: false, trashed: false, ...extra,
    }
}

function entryMap(...list: ManagerEntry[]): Map<string, ManagerEntry> {
    return new Map(list.map((e) => [e.chaId, e]))
}

const all = () => true

function shape(sections: ReturnType<typeof buildGridSections>) {
    return sections.map((s) => ({ folder: s.folder?.id, ids: s.items.map((e) => e.chaId), start: s.start }))
}

describe('buildGridSections', () => {
    it('keeps the rail sequence: folders as sections, loose runs between them', () => {
        const order: OrderEntry[] = [
            'a', 'b',
            { id: 'f1', name: 'One', color: 'red', data: ['c', 'd'] },
            'e',
            { id: 'f2', name: 'Two', color: '', data: ['f'] },
        ]
        const entries = entryMap(...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => entry(id)))
        expect(shape(buildGridSections(order, entries, all, true))).toEqual([
            { folder: undefined, ids: ['a', 'b'], start: 0 },
            { folder: 'f1', ids: ['c', 'd'], start: 2 },
            { folder: undefined, ids: ['e'], start: 4 },
            { folder: 'f2', ids: ['f'], start: 5 },
        ])
    })

    it('shows empty folders only when asked, and merges the loose runs around a dropped one', () => {
        const order: OrderEntry[] = ['a', { id: 'f1', name: 'Empty', color: '', data: [] }, 'b']
        const entries = entryMap(entry('a'), entry('b'))
        expect(shape(buildGridSections(order, entries, all, true))).toEqual([
            { folder: undefined, ids: ['a'], start: 0 },
            { folder: 'f1', ids: [], start: 1 },
            { folder: undefined, ids: ['b'], start: 1 },
        ])
        expect(shape(buildGridSections(order, entries, all, false))).toEqual([
            { folder: undefined, ids: ['a', 'b'], start: 0 },
        ])
    })

    it('skips trashed, filtered-out, unknown and repeated characters', () => {
        const order: OrderEntry[] = [
            'a', 'gone',
            { id: 'f1', name: 'One', color: '', data: ['a', 'b', 'c'] },
            'd',
        ]
        const entries = entryMap(entry('a'), entry('b', { trashed: true }), entry('c', { hidden: true }), entry('d'))
        const notHidden = (e: ManagerEntry) => !e.hidden
        // f1 ends up with nothing to show (a repeated, b trashed, c filtered out), so it drops out.
        expect(shape(buildGridSections(order, entries, notHidden, false))).toEqual([
            { folder: undefined, ids: ['a', 'd'], start: 0 },
        ])
    })

    it('gives every section a unique key', () => {
        const order: OrderEntry[] = [
            'a', { id: 'f1', name: 'One', color: '', data: ['b'] }, 'c', { id: 'f2', name: 'Two', color: '', data: [] }, 'd',
        ]
        const entries = entryMap(entry('a'), entry('b'), entry('c'), entry('d'))
        const keys = buildGridSections(order, entries, all, true).map((s) => s.key)
        expect(new Set(keys).size).toBe(keys.length)
    })
})

describe('gridDropTarget', () => {
    const order = (): OrderEntry[] => [
        'a', 'b',
        { id: 'f1', name: 'One', color: '', data: ['c', 'trashed', 'd'] },
        'e',
        { id: 'f2', name: 'Empty', color: '', data: [] },
    ]
    const drop = (id: string, folderId: string | undefined, prev?: string, next?: string) => {
        const target = gridDropTarget(order(), folderId, prev, next)
        return target && moveSidebarItem(order(), { kind: 'character', id }, target)
    }
    const flat = (next: ReturnType<typeof drop>) => next?.map((entry) => typeof entry === 'string' ? entry : `${entry.id}[${entry.data.join(',')}]`)

    it('places a thumbnail before the one it now sits in front of, in its section', () => {
        expect(flat(drop('b', undefined, undefined, 'a'))).toEqual(['b', 'a', 'f1[c,trashed,d]', 'e', 'f2[]'])
        expect(flat(drop('d', 'f1', undefined, 'c'))).toEqual(['a', 'b', 'f1[d,c,trashed]', 'e', 'f2[]'])
    })

    it('places one at the end of a section after the last tile, leaving undrawn ones where they are', () => {
        expect(flat(drop('c', 'f1', 'd', undefined))).toEqual(['a', 'b', 'f1[trashed,d,c]', 'e', 'f2[]'])
        expect(flat(drop('a', undefined, 'b', undefined))).toEqual(['b', 'a', 'f1[c,trashed,d]', 'e', 'f2[]'])
    })

    it('moves between folders and the loose runs', () => {
        expect(flat(drop('a', 'f1', 'c', 'd'))).toEqual(['b', 'f1[c,trashed,a,d]', 'e', 'f2[]'])
        expect(flat(drop('d', undefined, undefined, 'e'))).toEqual(['a', 'b', 'f1[c,trashed]', 'd', 'e', 'f2[]'])
        // A folder left with one card dissolves, as on the rail (dissolveSingletonFolders).
        expect(flat(drop('e', 'f2'))).toEqual(['a', 'b', 'f1[c,trashed,d]', 'e'])
    })

    it('refuses a drop whose neighbour is not where the grid showed it', () => {
        expect(gridDropTarget(order(), 'f1', undefined, 'a')).toBeNull()
        expect(gridDropTarget(order(), undefined, 'c')).toBeNull()
        expect(gridDropTarget(order(), 'missing')).toBeNull()
        expect(gridDropTarget(order(), undefined)).toBeNull()
    })
})
