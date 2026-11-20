import { describe, expect, it } from 'vitest'
import { botLinkFolderName, gatherLinkedModules, LINK_FOLDER_NAME, linkedModuleIds, linkKindOf, MANUAL_LINK_FOLDER_NAME } from './linkedModuleFolder'
import { sortModuleFoldersByActivation } from './moduleSort'
import type { ModuleFolder } from './moduleFolders'

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
    const gather = (modules: ReturnType<typeof m>[], folders: ModuleFolder[], bots: { chaId: string, name: string, modules: string[], trashTime?: number }[]) =>
        gatherLinkedModules(modules, folders, linkedModuleIds(bots), newId, bots)

    it('keeps one link in [링크2], but gives two exclusive links a top-level bot folder across kinds', () => {
        n = 0
        const one = gather([m('a')], [], [{ chaId: 'A', name: 'A', modules: ['a'] }])!
        expect(one.folders).toMatchObject([{ name: MANUAL_LINK_FOLDER_NAME, moduleIds: ['a'] }])
        const two = gather([m('a'), p('b')], [{ id: 'U', name: 'Mine', moduleIds: [], sortOrder: 0 }], [{ chaId: 'A', name: 'A', modules: ['a', 'b'] }])!
        const bot = two.folders.find((folder) => folder.nodeOnlyLinkBotIds?.[0] === 'A')!
        expect(bot).toMatchObject({ name: '[링크 : A]', nodeOnlyLinkFolder: true, moduleIds: ['a', 'b'], sortOrder: -1 })
        expect(bot.nodeOnlyParentFolderId).toBeUndefined()
        expect(two.folders.some((folder) => folder.name === LINK_FOLDER_NAME || folder.name === MANUAL_LINK_FOLDER_NAME)).toBe(false)
        expect(sortModuleFoldersByActivation(two.folders, two.modules)[0].id).toBe(bot.id)
        expect(gather(two.modules, two.folders, [{ chaId: 'A', name: 'A', modules: ['a', 'b'] }])).toBeNull()
        const dropped = gather(two.modules, two.folders, [{ chaId: 'A', name: 'A', modules: ['a'] }])!
        expect(dropped.folders.some((folder) => folder.nodeOnlyLinkBotIds)).toBe(false)
        expect(dropped.modules.find((module) => module.id === 'a')?.folderId).toBe(dropped.folders.find((folder) => folder.name === MANUAL_LINK_FOLDER_NAME)?.id)
        expect(dropped.modules.find((module) => module.id === 'b')?.folderId).toBeUndefined()
    })

    it('excludes shared and user-folder modules from each bot threshold', () => {
        n = 0
        const bots = [{ chaId: 'A', name: 'A', modules: ['a', 'shared', 'mine'] }, { chaId: 'B', name: 'B', modules: ['shared'] }]
        const result = gather([m('a'), m('shared'), m('mine', 'U')], [{ id: 'U', name: 'Mine', moduleIds: [] }], bots)!
        expect(result.folders.some((folder) => folder.nodeOnlyLinkBotIds)).toBe(false)
        expect(result.folders.find((folder) => folder.name === MANUAL_LINK_FOLDER_NAME)?.moduleIds).toEqual(['a', 'shared'])
        expect(result.modules.find((module) => module.id === 'mine')?.folderId).toBe('U')
    })

    it('moves a newly shared Proton module out of a bot folder into [링크]', () => {
        n = 0
        const first = gather([m('a'), p('shared')], [], [{ chaId: 'A', name: 'A', modules: ['a', 'shared'] }])!
        const second = gather(first.modules, first.folders, [
            { chaId: 'A', name: 'A', modules: ['a', 'shared'] },
            { chaId: 'B', name: 'B', modules: ['shared'] },
        ])!
        expect(second.folders.some((folder) => folder.nodeOnlyLinkBotIds)).toBe(false)
        expect(second.folders.find((folder) => folder.name === LINK_FOLDER_NAME)?.moduleIds).toEqual(['shared'])
        expect(second.folders.find((folder) => folder.name === MANUAL_LINK_FOLDER_NAME)?.moduleIds).toEqual(['a'])
    })

    it('groups two shared modules by their bot set and reuses the folder on sync', () => {
        n = 0
        const bots = [{ chaId: 'A', name: 'A', modules: ['x', 'y'] }, { chaId: 'B', name: 'B', modules: ['x', 'y'] }]
        const first = gather([m('x'), p('y')], [], bots)!
        expect(first.folders).toMatchObject([{ name: '[링크 : A, B]', nodeOnlyLinkBotIds: ['A', 'B'], moduleIds: ['x', 'y'] }])
        expect(gather(first.modules, first.folders, bots)).toBeNull()
        const renamed = gather(first.modules, first.folders, [{ ...bots[0], name: 'New' }, bots[1]])!
        expect(renamed.folders[0]).toMatchObject({ id: first.folders[0].id, name: '[링크 : New, B]', nodeOnlyLinkBotIds: ['A', 'B'] })
    })

    it('leaves one shared module in its link folder', () => {
        n = 0
        const bots = [{ chaId: 'A', name: 'A', modules: ['x'] }, { chaId: 'B', name: 'B', modules: ['x'] }]
        const first = gather([p('x')], [], bots)!
        expect(first.folders).toMatchObject([{ name: LINK_FOLDER_NAME, moduleIds: ['x'] }])
        expect(first.folders.some((folder) => folder.nodeOnlyLinkBotIds)).toBe(false)
        expect(gather(first.modules, first.folders, bots)).toBeNull()
    })

    it('keeps own and shared groups separate, then dissolves groups as B unlinks', () => {
        n = 0
        const bots = [{ chaId: 'A', name: 'A', modules: ['a', 'b', 'x', 'y'] }, { chaId: 'B', name: 'B', modules: ['x', 'y'] }]
        const first = gather([m('a'), m('b'), m('x'), m('y')], [], bots)!
        expect(first.folders.filter((folder) => folder.nodeOnlyLinkBotIds).map((folder) => [folder.name, folder.moduleIds]))
            .toEqual([['[링크 : A, B]', ['x', 'y']], ['[링크 : A]', ['a', 'b']]])
        const second = gather(first.modules, first.folders, [bots[0], { ...bots[1], modules: ['y'] }])!
        expect(second.folders.find((folder) => folder.nodeOnlyLinkBotIds?.join() === 'A')?.moduleIds).toEqual(['a', 'b', 'x'])
        expect(second.folders.some((folder) => folder.nodeOnlyLinkBotIds?.join() === 'A,B')).toBe(false)
        expect(second.folders.find((folder) => folder.name === MANUAL_LINK_FOLDER_NAME)?.moduleIds).toEqual(['y'])
        const third = gather(second.modules, second.folders, [bots[0], { ...bots[1], modules: [] }])!
        expect(third.folders.find((folder) => folder.nodeOnlyLinkBotIds?.join() === 'A')?.moduleIds).toEqual(['a', 'b', 'x', 'y'])
        expect(third.folders.some((folder) => folder.name === MANUAL_LINK_FOLDER_NAME)).toBe(false)
        expect(gather(third.modules, third.folders, [bots[0], { ...bots[1], modules: [] }])).toBeNull()
    })

    it('orders names and stored IDs by characters order even when links list another bot first', () => {
        n = 0
        const bots = [{ chaId: 'B', name: 'Bee', modules: ['x', 'y'] }, { chaId: 'A', name: '  ', modules: ['y', 'x'] }]
        const first = gather([m('x'), m('y')], [], bots)!
        expect(first.folders[0]).toMatchObject({ name: '[링크 : Bee, 이름 없음]', nodeOnlyLinkBotIds: ['B', 'A'] })
        expect(gather(first.modules, first.folders, bots)).toBeNull()
        const reordered = gather(first.modules, first.folders, [...bots].reverse())!
        expect(reordered.folders[0]).toMatchObject({ id: first.folders[0].id, name: '[링크 : 이름 없음, Bee]', nodeOnlyLinkBotIds: ['A', 'B'] })
        expect(gather(reordered.modules, reordered.folders, [...bots].reverse())).toBeNull()
    })

    it('moves a shared group to the remaining bot when the other bot is trashed', () => {
        n = 0
        const bots = [{ chaId: 'A', name: 'A', modules: ['x', 'y'] }, { chaId: 'B', name: 'B', modules: ['x', 'y'] }]
        const first = gather([m('x'), m('y')], [], bots)!
        const second = gather(first.modules, first.folders, [bots[0], { ...bots[1], trashTime: 1 }])!
        expect(second.folders).toMatchObject([{ name: '[링크 : A]', nodeOnlyLinkBotIds: ['A'], moduleIds: ['x', 'y'] }])
        expect(second.folders.some((folder) => folder.nodeOnlyLinkBotIds?.includes('B'))).toBe(false)
    })

    it('releases a user folder nested under a bot folder', () => {
        n = 0
        const first = gather([m('a'), m('b')], [], [{ chaId: 'A', name: 'A', modules: ['a', 'b'] }])!
        const parent = first.folders.find((folder) => folder.nodeOnlyLinkBotIds?.[0] === 'A')!
        const nested = { id: 'U', name: 'Mine', moduleIds: [], nodeOnlyParentFolderId: parent.id }
        const second = gather([...first.modules, m('mine', 'U')], [...first.folders, nested], [{ chaId: 'A', name: 'A', modules: ['a', 'b', 'mine'] }])!
        expect(second.folders.find((folder) => folder.id === 'U')?.nodeOnlyParentFolderId).toBeUndefined()
        expect(second.modules.find((module) => module.id === 'mine')?.folderId).toBe('U')
    })

    it('renames, dissolves trashed bots, and supports two qualifying bots', () => {
        n = 0
        const modules = [m('a'), m('b'), m('c'), m('d')]
        const bots = [{ chaId: 'A', name: 'A', modules: ['a', 'b'] }, { chaId: 'B', name: 'B', modules: ['c', 'd'] }]
        const first = gather(modules, [], bots)!
        expect(first.folders.filter((folder) => folder.nodeOnlyLinkBotIds).map((folder) => folder.name).sort()).toEqual(['[링크 : A]', '[링크 : B]'])
        const renamed = gather(first.modules, first.folders, [{ ...bots[0], name: 'New' }, bots[1]])!
        expect(renamed.folders.find((folder) => folder.nodeOnlyLinkBotIds?.[0] === 'A')?.name).toBe('[링크 : New]')
        const trashed = gather(renamed.modules, renamed.folders, [{ ...bots[0], trashTime: 1 }, bots[1]])!
        expect(trashed.folders.some((folder) => folder.nodeOnlyLinkBotIds?.[0] === 'A')).toBe(false)
        expect(trashed.modules.filter((module) => ['a', 'b'].includes(module.id)).every((module) => !module.folderId)).toBe(true)
        expect(botLinkFolderName(['  '])).toBe('[링크 : 이름 없음]')
    })

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
