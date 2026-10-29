import { describe, expect, it } from 'vitest'
import { composeImagePrompt, lorebookPresets, PRESET_NAI_HINT } from './illustration'
import {
    ensureIllustrationModule,
    folderIllustrationPresetsOnce,
    illustrationModuleOf,
    legacyPresetSections,
    presetLorebookEntry,
    presetLorebookFolder,
    restoreIllustrationPresetsOnce,
    syncPresetFolder,
    syncPresetFolders,
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

    // The user's choice (2026-10-28): a folder with one entry per section.
    it('writes a preset folder of 전체, Positive, Negative and NAI entries that never fire', () => {
        const entries = presetLorebookFolder('Soft', { positive: 'a, {prompt}', negative: 'bad', nai: 'steps: 20' }, 'F')
        expect(entries.map((e) => [e.mode, e.comment, e.key, e.folder ?? null])).toEqual([
            ['folder', '프리셋 Soft', 'F', null],
            ['normal', '전체', '', 'F'],
            ['normal', 'Positive', '', 'F'],
            ['normal', 'Negative', '', 'F'],
            ['normal', 'NAI', '', 'F'],
        ])
        expect(entries.every((e) => !e.alwaysActive && !e.selective)).toBe(true)
        expect(entries[1].content).toBe('[Positive]\na, {prompt}\n\n[Negative]\nbad\n\n[NAI]\nsteps: 20')
        expect(lorebookPresets([{ label: 'm', entries }])).toEqual([
            { name: 'Soft', positive: 'a, {prompt}', negative: 'bad', nai: { steps: 20 }, source: 'm' },
        ])
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
        expect(module.lorebook!.filter((e) => e.mode === 'folder').map((e) => e.comment)).toEqual(['프리셋 Soft', '프리셋 Ink'])
        expect(module.lorebook).toHaveLength(10)
    })

    it('skips a name the module already has, and lifts the module to the top', () => {
        const db = database({ nodeOnlyIllustrationPresets: [{ name: 'Soft', positive: 'old', negative: '' }, { name: 'New', positive: 'n', negative: '' }] })
        const module = ensureIllustrationModule(db, make())
        module.lorebook = [presetLorebookEntry('Soft', '[Positive]\nmine\n[Negative]\n')]
        db.moduleActivationHistory = [module.id, 'other']
        expect(restoreIllustrationPresetsOnce(db, make())).toBe(1)
        expect(lorebookPresets([{ label: '', entries: module.lorebook }]).map((p) => p.positive)).toEqual(['mine', 'n'])
        expect(db.moduleActivationHistory?.at(-1)).toBe(module.id)
    })

    it('makes no module when there was nothing to restore', () => {
        const db = database()
        expect(restoreIllustrationPresetsOnce(db, make())).toBe(0)
        expect(illustrationModuleOf(db)).toBeUndefined()
        expect(db.nodeOnlyIllustrationPresetsRestored).toBe(true)
    })

    it('keeps the old text as it was', () => {
        expect(legacyPresetSections({ positive: ' a, {prompt} ', negative: ' bad ' })).toEqual({ positive: 'a, {prompt}', negative: 'bad', nai: PRESET_NAI_HINT })
    })
})

describe('one-entry presets of the 🎨 module into folders', () => {
    it('makes each a folder where it stood, keeps the old entry unread, and runs once', () => {
        const db = database()
        const module = ensureIllustrationModule(db, make())
        const story = { key: 'k', secondkey: '', insertorder: 100, comment: 'story', content: 'x', mode: 'normal' as const, alwaysActive: true, selective: false }
        module.lorebook = [
            presetLorebookEntry('Soft', '# from sample.png\n[Positive]\nartist:a, {prompt}\n[Negative]\nlowres\n[NAI]\nsteps: 20'),
            story,
            presetLorebookEntry('Light', '[Author] artist:b\n[Quality] best quality\n[Negative] bad'),
            ...presetLorebookFolder('Kept', { positive: 'k', negative: '', nai: '' }, 'K'),
            presetLorebookEntry('Kept', '[Positive]\nshadowed'),
        ]
        expect(folderIllustrationPresetsOnce(db, make())).toBe(2)
        const book = module.lorebook!
        expect(book.map((e) => e.comment)).toEqual([
            '프리셋 Soft', '전체', 'Positive', 'Negative', 'NAI', '(폴더로 옮김) 프리셋 Soft',
            'story',
            '프리셋 Light', '전체', 'Positive', 'Negative', 'NAI', '(폴더로 옮김) 프리셋 Light',
            '프리셋 Kept', '전체', 'Positive', 'Negative', 'NAI', '프리셋 Kept',
        ])
        expect(book[6]).toBe(story)
        expect(book[4].content).toBe('# from sample.png\nsteps: 20')
        const presets = lorebookPresets([{ label: '', entries: book }])
        expect(presets.map((p) => [p.name, p.positive, p.negative, p.nai ?? null])).toEqual([
            ['Soft', 'artist:a, {prompt}', 'lowres', { steps: 20 }],
            ['Light', 'artist:b, {prompt}, best quality', 'bad', null],
            ['Kept', 'k', '', null],
        ])
        expect(db.nodeOnlyIllustrationPresetsFoldered).toBe(true)

        module.lorebook = [presetLorebookEntry('Late', '[Positive]\nx')]
        expect(folderIllustrationPresetsOnce(db, make())).toBe(0)
        expect(module.lorebook).toHaveLength(1)
    })

    it('only marks the save when there is no 🎨 module', () => {
        const db = database()
        expect(folderIllustrationPresetsOnce(db, make())).toBe(0)
        expect(illustrationModuleOf(db)).toBeUndefined()
        expect(db.nodeOnlyIllustrationPresetsFoldered).toBe(true)
    })
})

// A shared style is one entry, pasted whole into 전체; its sections follow,
// and editing a section rewrites 전체 (the user's request, 2026-10-30).
describe('a preset folder\'s 전체 entry and its sections', () => {
    const folder = () => presetLorebookFolder('Soft', { positive: 'a, {prompt}', negative: 'bad', nai: '# hint' }, 'F')
    const comments = (book: { comment: string }[]) => book.map((e) => e.comment)
    const content = (book: { comment: string, content: string }[], name: string) => book.find((e) => e.comment === name)?.content

    it('pasted into 전체, a shared style fills the sections and is read', () => {
        const book = folder()
        book[1].content = '[Author]\nartist:x\n[Quality]\nbest quality\n[Negative]\nlowres'
        // read before the sections are synced: 전체 was edited last
        expect(lorebookPresets([{ label: '', entries: book }])[0].positive).toBe('artist:x, {prompt}, best quality')
        expect(syncPresetFolder(book, 'F')).toBe(true)
        expect(content(book, 'Positive')).toBe('artist:x, {prompt}, best quality')
        expect(content(book, 'Negative')).toBe('lowres')
        expect(content(book, 'NAI')).toBe(PRESET_NAI_HINT)
        expect(syncPresetFolder(book, 'F')).toBe(false)
        expect(lorebookPresets([{ label: '', entries: book }])[0]).toMatchObject({ positive: 'artist:x, {prompt}, best quality', negative: 'lowres' })
    })

    it('a section edited rewrites 전체, and is what is read', () => {
        const book = folder()
        book.find((e) => e.comment === 'Negative')!.content = 'worse'
        expect(lorebookPresets([{ label: '', entries: book }])[0].negative).toBe('worse')
        syncPresetFolder(book, 'F')
        expect(content(book, '전체')).toBe('[Positive]\na, {prompt}\n\n[Negative]\nworse\n\n[NAI]\n# hint')
        expect(lorebookPresets([{ label: '', entries: book }])[0].negative).toBe('worse')
    })

    it('tags alone in 전체 are its Positive', () => {
        const book = folder()
        book[1].content = 'artist:y, soft light'
        syncPresetFolder(book, 'F')
        expect(content(book, 'Positive')).toBe('artist:y, soft light')
        expect(content(book, 'Negative')).toBe('bad')
        expect(lorebookPresets([{ label: '', entries: book }])[0].positive).toBe('artist:y, soft light')
    })

    it('a folder from before gets its 전체; one with only 전체 gets its sections', () => {
        const old = folder().filter((e) => e.comment !== '전체').map((e) => ({ ...e, nodeOnlyPresetSync: undefined }))
        expect(syncPresetFolder(old, 'F')).toBe(true)
        expect(comments(old)).toEqual(['프리셋 Soft', '전체', 'Positive', 'Negative', 'NAI'])
        expect(content(old, '전체')).toBe('[Positive]\na, {prompt}\n\n[Negative]\nbad\n\n[NAI]\n# hint')

        const pasted = [folder()[0], { ...folder()[1], content: '[Positive]\nz, {prompt}\n[Negative]\nn' }].map((e) => ({ ...e, nodeOnlyPresetSync: undefined }))
        syncPresetFolder(pasted, 'F')
        expect(comments(pasted)).toEqual(['프리셋 Soft', '전체', 'Positive', 'Negative', 'NAI'])
        expect(content(pasted, 'Positive')).toBe('z, {prompt}')
    })

    it('leaves folders that are not presets alone', () => {
        const book = [{ ...folder()[0], comment: 'notes' }, { ...folder()[1], content: 'x' }]
        expect(syncPresetFolder(book, 'F')).toBe(false)
        expect(syncPresetFolders(book)).toBe(false)
    })
})
