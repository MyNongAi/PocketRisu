import { describe, expect, it } from 'vitest'
import { gatherLinkedModules, LINK_FOLDER_NAME, linkedModuleIds, linkKindOf, MANUAL_LINK_FOLDER_NAME } from './linkedModuleFolder'
import { sortModuleFoldersByActivation } from './moduleSort'

const m = (id: string, folderId?: string, name = id) => ({ id, name, ...(folderId ? { folderId } : {}) })
// A module fetched from a Proton share: a Realm card's asset module.
const p = (id: string, folderId?: string, name = id) => ({ ...m(id, folderId, name), nodeOnlyProtonShare: `https://drive.proton.me/urls/${id}` })
let n = 0
const newId = () => `N${++n}`
const ids = (result: { modules: { id: string, folderId?: string }[] }) => result.modules.map((x) => `${x.id}:${x.folderId ?? '-'}`)
const autoLink = (extra = {}) => ({ id: 'L', name: LINK_FOLDER_NAME, moduleIds: [], nodeOnlyLinkFolder: true, ...extra })
const manualLink = (extra = {}) => ({ id: 'H', name: MANUAL_LINK_FOLDER_NAME, moduleIds: [], nodeOnlyLinkFolder: true, nodeOnlyLinkKind: 'manual' as const, ...extra })

describe('linkedModuleIds', () => {
    it('collects the modules of bots outside the trash', () => {
        expect([...linkedModuleIds([{ modules: ['a', 'b'] }, { modules: ['c'], trashTime: 1 }, null, {}])]).toEqual(['a', 'b'])
    })
})

describe('linkKindOf', () => {
    it('sends Proton share modules to [링크] and the rest to [링크2]', () => {
        expect(linkKindOf(p('a'))).toBe('auto')
        expect(linkKindOf({ nodeOnlyProtonSource: { link: 'x' } })).toBe('auto')
        expect(linkKindOf({ ...m('b'), nodeOnlyProtonShare: undefined })).toBe('manual')
    })
})

describe('gatherLinkedModules', () => {
    const userFolder = { id: 'U', name: 'Mine', moduleIds: [] }
    const similar = (id: string, extra = {}) => ({ id, name: `[유사 후보] ${id} · 2개`, moduleIds: [], duplicateCandidate: { kind: 'module', key: id }, ...extra })

    it('moves a loose Proton module into [링크] and one linked by hand into [링크2]; a user folder and its modules stay', () => {
        n = 0
        const result = gatherLinkedModules([p('asset', undefined, 'Alpha'), m('hand', undefined, 'Beta'), m('u1', 'U'), m('u2', 'U'), m('other')], [userFolder], new Set(['asset', 'hand', 'u1']), newId)!
        expect(ids(result)).toEqual(['asset:N1', 'hand:N2', 'u1:U', 'u2:U', 'other:-'])
        expect(result.folders.find((f) => f.id === 'N1')).toMatchObject({ name: LINK_FOLDER_NAME, nodeOnlyLinkFolder: true, moduleIds: ['asset'] })
        expect(result.folders.find((f) => f.id === 'N1')?.nodeOnlyLinkKind).toBeUndefined()
        expect(result.folders.find((f) => f.id === 'N2')).toMatchObject({ name: MANUAL_LINK_FOLDER_NAME, nodeOnlyLinkFolder: true, nodeOnlyLinkKind: 'manual', moduleIds: ['hand'] })
        const user = result.folders.find((f) => f.id === 'U')!
        expect(user.moduleIds).toEqual(['u1', 'u2'])
        expect(user.nodeOnlyParentFolderId).toBeUndefined()
    })

    it('brings a folder an older build showed inside [링크] back out, its modules with it', () => {
        const result = gatherLinkedModules([p('a', 'L'), m('u1', 'U')], [autoLink(), { ...userFolder, nodeOnlyParentFolderId: 'L' }], new Set(['a', 'u1']), newId)!
        expect(ids(result)).toEqual(['a:L', 'u1:U'])
        expect(result.folders.find((f) => f.id === 'U')?.nodeOnlyParentFolderId).toBeUndefined()
    })

    it('moves a module linked by hand out of [링크] into [링크2]', () => {
        n = 0
        const result = gatherLinkedModules([p('a', 'L'), m('h', 'L')], [autoLink()], new Set(['a', 'h']), newId)!
        expect(ids(result)).toEqual(['a:L', 'h:N1'])
        expect(result.folders.find((f) => f.id === 'N1')).toMatchObject({ nodeOnlyLinkKind: 'manual', moduleIds: ['h'] })
    })

    it('puts a new link folder first in an ordered catalog, so 최근순 shows it at the top', () => {
        n = 0
        const folders = [{ ...userFolder, sortOrder: 0 }, { id: 'V', name: 'Other', moduleIds: [], sortOrder: 1 }]
        const modules = [m('h'), m('v1', 'V')]
        const result = gatherLinkedModules(modules, folders, new Set(['h']), newId)!
        expect(result.folders.find((f) => f.id === 'N1')?.sortOrder).toBe(-1)
        expect(sortModuleFoldersByActivation(result.folders, result.modules).map((f) => f.id)).toEqual(['N1', 'U', 'V'])
    })

    it('groups near-duplicate modules loose in [링크] into a [유사 후보] folder inside it, and renames the old [링크]', () => {
        n = 0
        const result = gatherLinkedModules(
            [p('w1', 'L', 'WW-Sim v1.2.0 에셋 모듈 · 상'), p('w2', 'L', 'WW-Sim v1.2.0 에셋 모듈 · 하'), p('k', 'L', 'Kivotos')],
            [autoLink({ name: '🔗 [링크]' })], new Set(['w1', 'w2', 'k']), newId)!
        const group = result.folders.find((f) => f.duplicateCandidate?.kind === 'module')!
        expect(group).toMatchObject({ nodeOnlyParentFolderId: 'L', moduleIds: ['w1', 'w2'] })
        expect(group.name).toMatch(/^\[유사 후보\] WW-Sim/)
        expect(result.folders.find((f) => f.id === 'L')).toMatchObject({ name: LINK_FOLDER_NAME, moduleIds: ['k'] })
    })

    it('sends unlinked modules back out, un-nests a [유사 후보] folder holding none, and drops empty link folders', () => {
        const nestedFolder = similar('S', { nodeOnlyParentFolderId: 'L' })
        const result = gatherLinkedModules([p('a', 'L'), m('h', 'H'), p('s1', 'S'), p('s2', 'S')], [autoLink(), manualLink(), nestedFolder], new Set(), newId)!
        expect(ids(result)).toEqual(['a:-', 'h:-', 's1:S', 's2:S'])
        expect(result.folders.map((f) => f.id)).toEqual(['S'])
        expect(result.folders[0].nodeOnlyParentFolderId).toBeUndefined()
    })

    it('changes nothing when everything is in place', () => {
        expect(gatherLinkedModules([p('a', 'L'), m('h', 'H'), m('b')], [autoLink(), manualLink()], new Set(['a', 'h']), newId)).toBeNull()
        expect(gatherLinkedModules([m('b')], [], new Set(), newId)).toBeNull()
        const nestedFolder = similar('S', { nodeOnlyParentFolderId: 'L' })
        expect(gatherLinkedModules([p('s1', 'S'), p('s2', 'S')], [autoLink(), nestedFolder], new Set(['s1', 's2']), newId)).toBeNull()
        expect(gatherLinkedModules([m('u1', 'U')], [userFolder], new Set(['u1']), newId)).toBeNull()
    })

    it('leaves a folder the user nested inside one of their own folders where it is', () => {
        const middle = { id: 'M', name: 'Middle', moduleIds: [] }
        const inner = { id: 'I', name: 'Inner', moduleIds: [], nodeOnlyParentFolderId: 'M' }
        expect(gatherLinkedModules([m('i1', 'I')], [middle, inner], new Set(['i1']), newId)).toBeNull()
    })
})
