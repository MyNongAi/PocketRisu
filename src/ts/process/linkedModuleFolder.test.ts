import { describe, expect, it } from 'vitest'
import { gatherLinkedModules, LINK_FOLDER_NAME, linkedModuleIds } from './linkedModuleFolder'

const m = (id: string, folderId?: string, name = id) => ({ id, name, ...(folderId ? { folderId } : {}) })
let n = 0
const newId = () => `N${++n}`
const ids = (result: { modules: { id: string, folderId?: string }[] }) => result.modules.map((x) => `${x.id}:${x.folderId ?? '-'}`)

describe('linkedModuleIds', () => {
    it('collects the modules of bots outside the trash', () => {
        expect([...linkedModuleIds([{ modules: ['a', 'b'] }, { modules: ['c'], trashTime: 1 }, null, {}])]).toEqual(['a', 'b'])
    })
})

describe('gatherLinkedModules', () => {
    const userFolder = { id: 'U', name: 'Mine', moduleIds: [] }
    const similar = (id: string) => ({ id, name: `[유사 후보] ${id} · 2개`, moduleIds: [], duplicateCandidate: { kind: 'module', key: id } })

    it('moves loose linked modules into a new [링크] folder at the top; a user folder keeps its own and shows inside it', () => {
        n = 0
        const result = gatherLinkedModules([m('loose', undefined, 'Alpha'), m('u1', 'U'), m('u2', 'U'), m('other')], [userFolder], new Set(['loose', 'u1']), newId)!
        expect(result.folders[0]).toMatchObject({ id: 'N1', name: LINK_FOLDER_NAME, nodeOnlyLinkFolder: true, moduleIds: ['loose'] })
        expect(ids(result)).toEqual(['loose:N1', 'u1:U', 'u2:U', 'other:-'])
        expect(result.folders.find((f) => f.id === 'U')).toMatchObject({ nodeOnlyParentFolderId: 'N1', moduleIds: ['u1', 'u2'] })
    })

    it('shows a generated folder whose modules are all linked inside [링크], keeping its modules', () => {
        n = 0
        const result = gatherLinkedModules([m('s1', 'S'), m('s2', 'S'), m('x')], [similar('S')], new Set(['s1', 's2', 'x']), newId)!
        expect(ids(result)).toEqual(['s1:S', 's2:S', 'x:N1'])
        expect(result.folders.find((f) => f.id === 'S')).toMatchObject({ nodeOnlyParentFolderId: 'N1', moduleIds: ['s1', 's2'] })
    })

    it('shows a partly linked folder inside [링크] too, leaving every module in it', () => {
        n = 0
        const result = gatherLinkedModules([m('s1', 'S'), m('s2', 'S'), m('s3', 'S')], [similar('S')], new Set(['s1']), newId)!
        expect(ids(result)).toEqual(['s1:S', 's2:S', 's3:S'])
        expect(result.folders.find((f) => f.id === 'S')?.nodeOnlyParentFolderId).toBe('N1')
    })

    it('groups near-duplicate modules loose in [링크] into a [유사 후보] folder inside it, and renames the old [링크]', () => {
        n = 0
        const link = { id: 'L', name: '🔗 [링크]', moduleIds: [], nodeOnlyLinkFolder: true }
        const result = gatherLinkedModules(
            [m('w1', 'L', 'WW-Sim v1.2.0 에셋 모듈 · 상'), m('w2', 'L', 'WW-Sim v1.2.0 에셋 모듈 · 하'), m('k', 'L', 'Kivotos')],
            [link], new Set(['w1', 'w2', 'k']), newId)!
        const group = result.folders.find((f) => f.duplicateCandidate?.kind === 'module')!
        expect(group).toMatchObject({ nodeOnlyParentFolderId: 'L', moduleIds: ['w1', 'w2'] })
        expect(group.name).toMatch(/^\[유사 후보\] WW-Sim/)
        expect(result.folders.find((f) => f.id === 'L')).toMatchObject({ name: LINK_FOLDER_NAME, moduleIds: ['k'] })
    })

    it('sends an unlinked module back out, un-nests a folder no longer all linked, and drops an empty [링크]', () => {
        const link = { id: 'L', name: LINK_FOLDER_NAME, moduleIds: [], nodeOnlyLinkFolder: true }
        const nestedFolder = { ...similar('S'), nodeOnlyParentFolderId: 'L' }
        const result = gatherLinkedModules([m('a', 'L'), m('s1', 'S'), m('s2', 'S')], [link, nestedFolder], new Set(), newId)!
        expect(ids(result)).toEqual(['a:-', 's1:S', 's2:S'])
        expect(result.folders.map((f) => f.id)).toEqual(['S'])
        expect(result.folders[0].nodeOnlyParentFolderId).toBeUndefined()
    })

    it('changes nothing when everything is in place', () => {
        const link = { id: 'L', name: LINK_FOLDER_NAME, moduleIds: [], nodeOnlyLinkFolder: true }
        expect(gatherLinkedModules([m('a', 'L'), m('b')], [link], new Set(['a']), newId)).toBeNull()
        expect(gatherLinkedModules([m('b')], [], new Set(), newId)).toBeNull()
        const nestedFolder = { ...similar('S'), nodeOnlyParentFolderId: 'L' }
        expect(gatherLinkedModules([m('s1', 'S'), m('s2', 'S')], [link, nestedFolder], new Set(['s1', 's2']), newId)).toBeNull()
    })
})
