import { describe, expect, it } from 'vitest'
import { gatherPresetModules, PRESET_FOLDER_NAME, PRESET_ORPHAN_FOLDER_NAME, presetsByNamespace, recordPresetLinks } from './presetModuleFolder'

let n = 0
const newId = () => `N${++n}`
const m = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, ...extra }) as any
const placed = (result: { modules: { id: string, folderId?: string }[] }) => result.modules.map((x) => `${x.id}:${x.folderId ?? '-'}`)

describe('presetsByNamespace', () => {
    it('lists the presets that turn each namespace on', () => {
        const map = presetsByNamespace([{ name: 'Yellow', moduleIntergration: 'dog, cat' }, { name: 'Blue', moduleIntergration: 'cat' }, { name: '', moduleIntergration: 'x' }, null])
        expect([...map]).toEqual([['dog', ['Yellow']], ['cat', ['Yellow', 'Blue']]])
    })
})

describe('recordPresetLinks', () => {
    it('remembers the presets a module goes with, and never forgets one', () => {
        const modules = [m('a', { namespace: 'dog' }), m('b', { namespace: 'none' }), m('c')]
        expect(recordPresetLinks(modules, [{ name: 'Yellow', moduleIntergration: 'dog' }])).toBe(true)
        expect(modules[0].nodeOnlyPresetLinks).toEqual(['Yellow'])
        expect(modules[1].nodeOnlyPresetLinks).toBeUndefined()
        // the preset is gone: the record stays
        expect(recordPresetLinks(modules, [])).toBe(false)
        expect(modules[0].nodeOnlyPresetLinks).toEqual(['Yellow'])
    })
})

describe('gatherPresetModules', () => {
    const presets = [{ name: 'Yellow', moduleIntergration: 'dog' }, { name: 'Blue', moduleIntergration: 'cat' }]

    it("puts loose modules a preset turns on in [프롬] › that preset's folder", () => {
        n = 0
        const result = gatherPresetModules([m('a', { namespace: 'dog' }), m('b', { namespace: 'cat' }), m('c', { namespace: 'other' })], [], presets, new Set(), newId)!
        const root = result.folders.find((f: any) => f.nodeOnlyPresetFolder === 'root')!
        expect(root).toMatchObject({ name: PRESET_FOLDER_NAME })
        const yellow = result.folders.find((f: any) => f.nodeOnlyPresetName === 'Yellow')!
        const blue = result.folders.find((f: any) => f.nodeOnlyPresetName === 'Blue')!
        expect(yellow).toMatchObject({ name: 'Yellow', nodeOnlyParentFolderId: root.id, moduleIds: ['a'] })
        expect(blue).toMatchObject({ name: 'Blue', moduleIds: ['b'] })
        expect(placed(result)).toEqual([`a:${yellow.id}`, `b:${blue.id}`, 'c:-'])
    })

    it("leaves a module in the user's own folder and one a bot carries", () => {
        n = 0
        const result = gatherPresetModules([m('a', { namespace: 'dog', folderId: 'U' }), m('b', { namespace: 'dog' })], [{ id: 'U', name: 'Mine', moduleIds: ['a'] }], presets, new Set(['b']), newId)
        expect(result).toBeNull()
    })

    it('shows a module whose presets are all gone in 프롬 없음, and takes [프롬] away once empty', () => {
        n = 0
        const first = gatherPresetModules([m('a', { namespace: 'dog', nodeOnlyPresetLinks: ['Yellow'] })], [], presets, new Set(), newId)!
        // the Yellow preset is deleted
        const second = gatherPresetModules(first.modules, first.folders, [presets[1]], new Set(), newId)!
        const orphans = second.folders.find((f: any) => f.nodeOnlyPresetFolder === 'orphans')!
        expect(orphans).toMatchObject({ name: PRESET_ORPHAN_FOLDER_NAME, moduleIds: ['a'] })
        expect(second.folders.some((f: any) => f.nodeOnlyPresetName === 'Yellow')).toBe(false)
        // the module is deleted: nothing of [프롬] is left
        const third = gatherPresetModules([], second.folders, [presets[1]], new Set(), newId)!
        expect(third.folders).toEqual([])
    })

    it('lets a module whose preset still exists but no longer names it go back to the top', () => {
        n = 0
        const first = gatherPresetModules([m('a', { namespace: 'dog', nodeOnlyPresetLinks: ['Yellow'] })], [], presets, new Set(), newId)!
        const unlinked = [{ name: 'Yellow', moduleIntergration: '' }, presets[1]]
        const second = gatherPresetModules(first.modules, first.folders, unlinked, new Set(), newId)!
        expect(placed(second)).toEqual(['a:-'])
        expect(second.folders).toEqual([])
    })

    it('changes nothing when everything is in place', () => {
        n = 0
        const first = gatherPresetModules([m('a', { namespace: 'dog' })], [], presets, new Set(), newId)!
        expect(gatherPresetModules(first.modules, first.folders, presets, new Set(), newId)).toBeNull()
    })
})
