import { describe, expect, it } from 'vitest'
import { gatherLinkedModules, LINK_FOLDER_NAME, linkedModuleIds } from './linkedModuleFolder'

const m = (id: string, folderId?: string) => ({ id, name: id, ...(folderId ? { folderId } : {}) })
const newId = () => 'L'

describe('linkedModuleIds', () => {
    it('collects the modules of bots outside the trash', () => {
        expect([...linkedModuleIds([{ modules: ['a', 'b'] }, { modules: ['c'], trashTime: 1 }, null, {}])]).toEqual(['a', 'b'])
    })
})

describe('gatherLinkedModules', () => {
    const folders = [
        { id: 'U', name: 'Mine', moduleIds: ['u1'] },
        { id: 'S', name: '[유사 후보] WW · 2개', moduleIds: ['s1', 's2'], duplicateCandidate: { kind: 'module', key: 'ww' } },
    ]

    it('moves loose and generated-folder modules into a new [링크] folder at the top; a user folder keeps its own', () => {
        const result = gatherLinkedModules([m('loose'), m('u1', 'U'), m('s1', 'S'), m('s2', 'S'), m('other')], folders, new Set(['loose', 'u1', 's1', 's2']), newId)!
        expect(result.folders[0]).toMatchObject({ id: 'L', name: LINK_FOLDER_NAME, nodeOnlyLinkFolder: true, moduleIds: ['loose', 's1', 's2'] })
        expect(result.modules.map((x) => `${x.id}:${x.folderId ?? '-'}`)).toEqual(['loose:L', 'u1:U', 's1:L', 's2:L', 'other:-'])
        // The emptied [유사 후보] folder is gone; the user's stays.
        expect(result.folders.map((f) => f.id)).toEqual(['L', 'U'])
    })

    it('sends an unlinked module back to the top level and drops an empty [링크] folder', () => {
        const withLink = [{ id: 'L', name: LINK_FOLDER_NAME, moduleIds: ['a'], nodeOnlyLinkFolder: true }, ...folders]
        const result = gatherLinkedModules([m('a', 'L'), m('u1', 'U')], withLink, new Set(), newId)!
        expect(result.modules.map((x) => x.folderId)).toEqual([undefined, 'U'])
        expect(result.folders.some((f) => f.id === 'L')).toBe(false)
    })

    it('changes nothing when every linked module is already in place', () => {
        const withLink = [{ id: 'L', name: LINK_FOLDER_NAME, moduleIds: ['a'], nodeOnlyLinkFolder: true }]
        expect(gatherLinkedModules([m('a', 'L'), m('b')], withLink, new Set(['a']), newId)).toBeNull()
        expect(gatherLinkedModules([m('b')], [], new Set(), newId)).toBeNull()
    })
})
