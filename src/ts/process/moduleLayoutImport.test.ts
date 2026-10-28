import { describe, expect, it } from 'vitest'
import { gatherLinkedModules } from './linkedModuleFolder'
import { applyModuleLayout, isModuleLayoutFile, MODULE_LAYOUT_TYPE, type ModuleLayoutFile, type ModuleLayoutMove } from './moduleLayoutImport'

const m = (id: string, folderId?: string) => ({ id, name: id, ...(folderId ? { folderId } : {}) })
const f = (id: string, name: string, extra = {}) => ({ id, name, moduleIds: [] as string[], ...extra })
const layout = (moves: ModuleLayoutMove[]): ModuleLayoutFile => ({ type: MODULE_LAYOUT_TYPE, ver: 1, moves })
let n = 0
const newId = () => `N${++n}`
const places = (result: { modules: { id: string, folderId?: string }[] }) => result.modules.map((x) => `${x.id}:${x.folderId ?? '-'}`)
const parents = (result: { folders: { id: string, name: string, nodeOnlyParentFolderId?: string }[] }) =>
    Object.fromEntries(result.folders.map((x) => [x.name, x.nodeOnlyParentFolderId ?? '-']))

describe('isModuleLayoutFile', () => {
    it('knows a layout file from a module file', () => {
        expect(isModuleLayoutFile(layout([]))).toBe(true)
        expect(isModuleLayoutFile({ type: 'risuModule', name: 'x', id: 'y' })).toBe(false)
        expect(isModuleLayoutFile({ type: MODULE_LAYOUT_TYPE })).toBe(false)
        expect(isModuleLayoutFile(null)).toBe(false)
    })
})

describe('applyModuleLayout', () => {
    it('makes the folders of a path once and puts modules in them', () => {
        n = 0
        const result = applyModuleLayout([m('a'), m('b', 'S'), m('c')], [f('S', '[출처] 로컬리스'), f('X', 'other')], layout([
            { module: 'a', to: ['2차', 'ZZZ'] },
            { module: 'b', to: ['2차', '붕괴'] },
            { module: 'c', to: ['2차', 'ZZZ'] },
        ]), newId)
        expect(places(result)).toEqual(['a:N2', 'b:N3', 'c:N2'])
        expect(parents(result)).toMatchObject({ '2차': '-', ZZZ: 'N1', 붕괴: 'N1' })
        expect(result.folders.find((x) => x.id === 'N2')?.moduleIds).toEqual(['a', 'c'])
        expect(result).toMatchObject({ movedModules: 3, movedFolders: 0, createdFolders: 3, skipped: 0 })
    })

    it('finds a folder the path names among the folders shown at that level', () => {
        n = 0
        const folders = [f('T', '2차'), f('Z', 'ZZZ', { nodeOnlyParentFolderId: 'T' }), f('Top', 'ZZZ')]
        const result = applyModuleLayout([m('a')], folders, layout([{ module: 'a', to: [' 2차 ', 'ZZZ'] }]), newId)
        expect(places(result)).toEqual(['a:Z'])
        expect(result.createdFolders).toBe(0)
    })

    it('puts a folder, with what it holds, inside another; a [유사 후보] folder can go, but no path leads into one', () => {
        n = 0
        const similar = f('D', '[유사 후보] 카스토리스 · 2개', { moduleIds: ['a', 'b'], duplicateCandidate: { kind: 'module', key: 'k' } })
        const result = applyModuleLayout([m('a', 'D'), m('b', 'D'), m('c', 'G'), m('x')], [similar, f('G', '소녀전선', { moduleIds: ['c'] })], layout([
            { folder: 'G', to: ['2차'] },
            { folder: 'D', to: ['2차', '붕괴'] },
            { module: 'c', to: ['2차', '소녀전선'] },
            { module: 'x', to: ['[유사 후보] 카스토리스 · 2개'] },
        ]), newId)
        const parentOf = (id: string) => result.folders.find((x) => x.id === id)?.nodeOnlyParentFolderId
        expect([parentOf('G'), parentOf('D'), parentOf('N2'), parentOf('N1')]).toEqual(['N1', 'N2', 'N1', undefined])
        // c already was in 소녀전선: the folder moved, not the module; x got a
        // folder of its own by that name at the top.
        expect(places(result)).toEqual(['a:D', 'b:D', 'c:G', 'x:N3'])
        expect(parentOf('N3')).toBeUndefined()
        expect(result).toMatchObject({ movedModules: 1, movedFolders: 2, createdFolders: 3 })
    })

    it('skips what is not there, a folder into itself or its own, and anything deeper than five', () => {
        n = 0
        const folders = [f('A', 'A'), f('B', 'B', { nodeOnlyParentFolderId: 'A' })]
        const result = applyModuleLayout([m('a')], folders, layout([
            { module: 'gone', to: ['X'] },
            { folder: 'gone', to: [] },
            { folder: 'A', to: ['A', 'B'] },
            { module: 'a', to: ['1', '2', '3', '4', '5', '6'] },
            { module: 'a', to: [''] },
            { to: ['X'] } as ModuleLayoutMove,
        ]), newId)
        expect(result.skipped).toBe(6)
        expect(places(result)).toEqual(['a:-'])
        // The folders made for the skipped deep path are gone again.
        expect(result.folders.map((x) => x.id)).toEqual(['A', 'B'])
        expect(result.createdFolders).toBe(0)
    })

    it('leaves [링크] and [프롬] folders alone', () => {
        n = 0
        const folders = [f('L', '[링크]', { nodeOnlyLinkFolder: true }), f('P', '[프롬]', { nodeOnlyPresetFolder: 'root' })]
        const result = applyModuleLayout([m('a', 'L')], folders, layout([
            { folder: 'L', to: ['2차'] },
            { folder: 'P', to: ['2차'] },
            { module: 'a', to: ['[링크]'] },
        ]), newId)
        expect(result.skipped).toBe(2)
        expect(result.folders.filter((x) => x.nodeOnlyParentFolderId)).toEqual([])
        // A path never reaches into [링크]: this is a folder of the user's by that name.
        expect(places(result)).toEqual(['a:N1'])
        expect(result.folders.find((x) => x.id === 'N1')?.nodeOnlyLinkFolder).toBeUndefined()
    })

    it('lets a folder emptied to one module go, as after a drag', () => {
        n = 0
        const result = applyModuleLayout([m('a', 'S'), m('b', 'S'), m('c', 'S')], [f('S', '[출처] 모바일웹리스', { moduleIds: ['a', 'b', 'c'] })], layout([
            { module: 'a', to: ['2차', '스카이림'] },
            { module: 'b', to: ['가챠섬'] },
        ]), newId)
        expect(result.folders.map((x) => x.name)).toEqual(['2차', '스카이림', '가챠섬'])
        expect(places(result)).toEqual(['a:N2', 'b:N3', 'c:-'])
    })

    it('keeps its places when [링크] gathers afterwards', () => {
        n = 0
        const placed = applyModuleLayout([m('a'), m('b')], [], layout([{ module: 'a', to: ['2차', 'ZZZ'] }]), newId)
        const gathered = gatherLinkedModules(placed.modules, placed.folders, new Set(['a', 'b']), newId)!
        expect(places(gathered)).toEqual(['a:N2', 'b:N3'])
    })
})
