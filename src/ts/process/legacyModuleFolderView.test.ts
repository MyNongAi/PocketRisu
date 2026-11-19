import { describe, expect, it } from 'vitest'
import { legacyModuleFolderView } from './legacyModuleFolderView'

describe('legacyModuleFolderView', () => {
    it('draws generated folders loose and flattens user folders without mutating input', () => {
        const folders = [
            { id: 'link', name: '[링크]', moduleIds: ['link-module'], nodeOnlyLinkFolder: true },
            { id: 'link2', name: '[링크2]', moduleIds: ['manual-link'], nodeOnlyLinkFolder: true, nodeOnlyLinkKind: 'manual' as const },
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
            { folderId: 'link' }, { folderId: 'link2' }, { folderId: 'preset' },
            { folderId: 'star' }, { folderId: 'candidate' }, { folderId: 'old-candidate' },
            { folderId: 'linked-user' }, { folderId: 'inner' }, { folderId: 'gone' },
        ]
        const before = structuredClone({ folders, modules })

        const view = legacyModuleFolderView(modules, folders)

        expect(view.folders.map((folder) => folder.id)).toEqual(['old-candidate', 'linked-user', 'outer', 'inner'])
        expect(view.itemFolderIds).toEqual([undefined, undefined, undefined, undefined, undefined, 'old-candidate', 'linked-user', 'inner', undefined])
        expect(view.folders.every((folder) => !folder.nodeOnlyParentFolderId)).toBe(true)
        expect({ folders, modules }).toEqual(before)
        expect(folders[7].nodeOnlyParentFolderId).toBe('link')
    })
})
