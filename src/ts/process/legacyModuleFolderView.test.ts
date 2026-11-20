import { describe, expect, it } from 'vitest'
import { interleaveLegacyModuleCatalogGroups, legacyActivationHistoryFromPlacements, legacyModuleFolderView, sortLegacyModulesByActivation, storedLegacyPlacements } from './legacyModuleFolderView'

describe('legacyModuleFolderView', () => {
    it('uses September favorite-first recency and promoted-entry interleaving', () => {
        const modules = [
            { id: 'favorite', name: 'Favorite', favorite: true },
            { id: 'recent', name: 'Recent' },
            { id: 'folder-member', name: 'Folder member', folderId: 'normal' },
        ]
        const sorted = sortLegacyModulesByActivation(modules, '', {
            fallbackOrders: [['favorite', 'folder-member']], activationHistory: ['recent'],
        })
        expect(sorted.map((module) => module.id)).toEqual(['favorite', 'recent', 'folder-member'])

        // Same priority as moduleSort.ts at 54288671e: the activated loose row,
        // then favorite folders, empty folders, and first-member interleaving.
        expect(interleaveLegacyModuleCatalogGroups([
            { folder: { id: 'favorite-folder', favorite: true }, indexes: [2] },
            { folder: { id: 'empty-folder' }, indexes: [] },
            { folder: { id: 'normal' }, indexes: [3] },
            { folder: null, indexes: [0, 1] },
        ], 1)).toEqual([
            { kind: 'root', indexes: [1] },
            { kind: 'folder', folderId: 'favorite-folder' },
            { kind: 'folder', folderId: 'empty-folder' },
            { kind: 'root', indexes: [0] },
            { kind: 'folder', folderId: 'normal' },
        ])
        expect(interleaveLegacyModuleCatalogGroups([
            { folder: { id: 'favorite-folder', favorite: true }, indexes: [1] },
            { folder: { id: 'normal' }, indexes: [2] },
            { folder: null, indexes: [0] },
        ], -1, 'normal')[0]).toEqual({ kind: 'folder', folderId: 'normal' })
    })

    it('keeps a loose drawn module in its hidden automatic folder after a menu reorder', () => {
        const stored = ['hidden-auto', undefined, 'visible']
        const drawn = [undefined, undefined, 'visible']
        const moved = [{ index: 1, folderId: undefined }, { index: 0, folderId: undefined }, { index: 2, folderId: 'visible' }]
        expect(storedLegacyPlacements(moved, drawn, stored)).toEqual([
            { index: 1, folderId: undefined },
            { index: 0, folderId: 'hidden-auto' },
            { index: 2, folderId: 'visible' },
        ])
        expect(legacyActivationHistoryFromPlacements(moved, ['hidden', 'loose', 'visible'])).toEqual(['visible', 'hidden', 'loose'])
    })

    it('draws generated folders loose and flattens user folders without mutating input', () => {
        const folders = [
            { id: 'link', name: '[링크]', moduleIds: ['link-module'], nodeOnlyLinkFolder: true },
            { id: 'link2', name: '[링크2]', moduleIds: ['manual-link'], nodeOnlyLinkFolder: true, nodeOnlyLinkKind: 'manual' as const },
            { id: 'bot-link', name: '[링크 : A]', moduleIds: ['bot-link-module'], nodeOnlyLinkFolder: true, nodeOnlyLinkBotIds: ['A'] },
            { id: 'prompt', name: '[프롬]', moduleIds: [], nodeOnlyPresetFolder: 'root' as const },
            { id: 'preset', name: 'preset', moduleIds: ['preset-module'], nodeOnlyPresetFolder: 'preset' as const, nodeOnlyParentFolderId: 'prompt' },
            { id: 'star', name: '★', moduleIds: ['favorite'], nodeOnlyFavoritesFolder: true },
            { id: 'candidate', name: '[유사 후보]', moduleIds: ['similar'], duplicateCandidate: { kind: 'module', key: 'same' }, nodeOnlyParentFolderId: 'link' },
            { id: 'old-candidate', name: '[유사 후보]', moduleIds: ['old-similar'], duplicateCandidate: { kind: 'module', key: 'old' } },
            { id: 'linked-user', name: 'Mine', moduleIds: ['mine'], nodeOnlyParentFolderId: 'link' },
            { id: 'outer', name: 'Outer', moduleIds: [] },
            { id: 'inner', name: 'Inner', moduleIds: ['nested'], nodeOnlyParentFolderId: 'outer' },
        ]
        const modules = [
            { folderId: 'link' }, { folderId: 'link2' }, { folderId: 'bot-link' }, { folderId: 'preset' },
            { folderId: 'star' }, { folderId: 'candidate' }, { folderId: 'old-candidate' },
            { folderId: 'linked-user' }, { folderId: 'inner' }, { folderId: 'gone' },
        ]
        const before = structuredClone({ folders, modules })

        const view = legacyModuleFolderView(modules, folders)

        expect(view.folders.map((folder) => folder.id)).toEqual(['old-candidate', 'linked-user', 'outer', 'inner'])
        expect(view.itemFolderIds).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, 'old-candidate', 'linked-user', 'inner', undefined])
        expect(view.folders.every((folder) => !folder.nodeOnlyParentFolderId)).toBe(true)
        expect({ folders, modules }).toEqual(before)
        expect(folders[8].nodeOnlyParentFolderId).toBe('link')
    })
})
