import { describe, expect, it } from 'vitest'
import { composeImagePrompt, lorebookPresets, parsePresetEntry } from './illustration'
import {
    ensureIllustrationModule,
    illustrationModuleOf,
    legacyPresetContent,
    presetLorebookEntry,
    restoreIllustrationPresetsOnce,
    type IllustrationModuleDb,
} from './illustrationModule'

let ids = 0
const make = () => ({ id: () => `art-${++ids}`, name: '🎨 삽화', description: 'presets', now: 1000 })
const scene = { line: 1, camera: 'cowboy shot', scene: '1girl', characters: [] }

function database(extra: Partial<IllustrationModuleDb> = {}): IllustrationModuleDb {
    return {
        modules: [{ id: 'other', name: 'Other', description: '', folderId: 'folder-1' }],
        enabledModules: ['other'],
        moduleActivationHistory: ['other'],
        ...extra,
    }
}

describe('the 🎨 illustration module', () => {
    it('is made once, at the top level and newest in the module list, and found by its marker', () => {
        const db = database()
        const module = ensureIllustrationModule(db, make())
        expect(module).toBe(db.modules[1])
        expect(module).toMatchObject({ name: '🎨 삽화', nodeOnlyIllustrationModule: true, lorebook: [], importedAt: 1000 })
        expect(module.folderId).toBeUndefined()
        expect(db.moduleActivationHistory?.at(-1)).toBe(module.id)

        module.name = 'renamed'
        expect(ensureIllustrationModule(db, make())).toBe(module)
        expect(illustrationModuleOf(db)).toBe(module)
        expect(db.modules).toHaveLength(2)
    })

    it('writes a preset entry that never fires for the main model', () => {
        expect(presetLorebookEntry('Soft', 'x')).toMatchObject({ comment: '프리셋 Soft', key: '', secondkey: '', alwaysActive: false, selective: false, mode: 'normal' })
    })
})

describe('restoring the old app-wide presets', () => {
    it('puts each into the module as a "프리셋 X" entry the reader takes as it was, once', () => {
        const legacy = [
            { id: 'p1', name: 'Soft', positive: 'artist:a, {prompt}, soft light', negative: 'lowres' },
            { id: 'p2', name: ' Ink ', positive: 'ink style', negative: '' },
            { id: 'p3', name: '  ', positive: 'blank name', negative: '' },
        ]
        const db = database({ nodeOnlyIllustrationPresets: legacy })
        expect(restoreIllustrationPresetsOnce(db, make())).toBe(2)
        const module = illustrationModuleOf(db)!
        const presets = lorebookPresets([{ label: module.name, entries: module.lorebook }])
        expect(presets.map((p) => [p.name, p.positive, p.negative])).toEqual([
            ['Soft', 'artist:a, {prompt}, soft light', 'lowres'],
            ['Ink', 'ink style', ''],
        ])
        // Without {prompt} the scene goes first, as the app-wide list did.
        expect(composeImagePrompt(presets[1], scene).positive).toBe('cowboy shot, 1girl, ink style')
        expect(db.nodeOnlyIllustrationPresetsRestored).toBe(true)
        expect(db.nodeOnlyIllustrationPresets).toBe(legacy)
        expect(db.moduleActivationHistory?.at(-1)).toBe(module.id)

        expect(restoreIllustrationPresetsOnce(db, make())).toBe(0)
        expect(module.lorebook).toHaveLength(2)
    })

    it('skips a name the module already has, and lifts the module to the top', () => {
        const db = database({ nodeOnlyIllustrationPresets: [{ name: 'Soft', positive: 'old', negative: '' }, { name: 'New', positive: 'n', negative: '' }] })
        const module = ensureIllustrationModule(db, make())
        module.lorebook = [presetLorebookEntry('Soft', '[Positive]\nmine\n[Negative]\n')]
        db.moduleActivationHistory = [module.id, 'other']
        expect(restoreIllustrationPresetsOnce(db, make())).toBe(1)
        expect(module.lorebook!.map((e) => parsePresetEntry(e.comment, e.content)?.positive)).toEqual(['mine', 'n'])
        expect(db.moduleActivationHistory?.at(-1)).toBe(module.id)
    })

    it('makes no module when there was nothing to restore', () => {
        const db = database()
        expect(restoreIllustrationPresetsOnce(db, make())).toBe(0)
        expect(illustrationModuleOf(db)).toBeUndefined()
        expect(db.nodeOnlyIllustrationPresetsRestored).toBe(true)
    })

    it('keeps the old text as it was', () => {
        expect(legacyPresetContent({ positive: ' a, {prompt} ', negative: ' bad ' })).toBe('[Positive]\na, {prompt}\n\n[Negative]\nbad')
    })
})
