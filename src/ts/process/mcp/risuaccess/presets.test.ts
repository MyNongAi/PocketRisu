import { beforeEach, describe, expect, it, vi } from 'vitest'

// Only synthetic presets are created here. The real database helpers exercise
// the active preset's root mirror and its save on a preset switch.
vi.mock('src/ts/stores.svelte', () => ({
  DBState: { db: {} },
  selectedCharID: { subscribe: () => () => {}, set: () => {}, update: () => {} },
  selIdState: { selId: -1 },
}))
vi.mock('src/ts/globalApi.svelte', () => ({ forageStorage: { realStorage: null }, downloadFile: () => {}, saveAsset: async () => '' }))
vi.mock('src/ts/alert', () => ({ notifySuccess: () => {}, notifyWarning: () => {}, alertError: () => {} }))
vi.mock('src/lang', () => ({ language: { recoveredPresetName: 'Recovered', recoveredPresetNotice: 'recovered' }, changeLanguage: () => {} }))
vi.mock('./writeAccess', () => ({ mcpWriteAccess: async () => false }))

const { DBState } = await import('src/ts/stores.svelte') as any
const { changeToPreset } = await import('src/ts/storage/database.svelte')
const { backupPreset, restoreEdits, editBackupCount } = await import('../editSession')
const { PresetHandler } = await import('./presets')
const { editKinds, setEditKind, risuAccessInstructions } = await import('./editKinds')

function preset(id: string, name: string, text: string) {
  return { id, name, mainPrompt: `${text} main`, jailbreak: `${text} jail`, globalNote: `${text} note`,
    customPromptTemplateToggle: `${text}=Label=text`, promptTemplate: [{ type: 'plain', type2: 'normal', role: 'system', text }],
    temperature: 0, maxContext: 0, maxResponse: 0, frequencyPenalty: 0, PresensePenalty: 0,
    formatingOrder: [], bias: [], promptPreprocess: false }
}

const response = (result: unknown) => JSON.parse((result as { text: string }[])[0].text)
let session: any
let allowed = true
let access: any
let handler: InstanceType<typeof PresetHandler>

beforeEach(() => {
  const a = preset('a', 'Alpha', 'alpha')
  const b = preset('b', 'Beta', 'beta')
  DBState.db = { botPresets: [a, b], botPresetsId: 0, characters: [], modules: [], NAIsettings: {},
    promptTemplate: structuredClone(a.promptTemplate), mainPrompt: a.mainPrompt, jailbreak: a.jailbreak,
    globalNote: a.globalNote, customPromptTemplateToggle: a.customPromptTemplateToggle }
  session = { approval: 'ask', startedAt: 1 }
  allowed = true
  access = vi.fn(async (_tool, _action, target) => {
    if (!allowed) return false
    backupPreset(session, target.value, target.index)
    return true
  })
  handler = new PresetHandler(access)
})

describe('prompt preset tools', () => {
  it('lists metadata without text and gets paged items plus preset fields', async () => {
    const listed = response(await handler.handle('risu-list-prompt-presets', {}))
    expect(listed).toEqual([
      { index: 0, name: 'Alpha', active: true, promptItems: 1, hasToggleTemplate: true },
      { index: 1, name: 'Beta', active: false, promptItems: 1, hasToggleTemplate: true },
    ])
    expect(JSON.stringify(listed)).not.toContain('alpha main')
    const got = response(await handler.handle('risu-get-prompt-preset', { name: 'Beta', limit: 1 }))
    expect(got).toMatchObject({ index: 1, active: false, totalItems: 1, offset: 0,
      items: [{ index: 0, type: 'plain', role: 'system', text: 'beta' }], mainPrompt: 'beta main', customPromptTemplateToggle: 'beta=Label=text' })
    expect(response(await handler.handle('risu-get-prompt-preset', { index: 1, offset: 1 })).items).toEqual([])
  })

  it('sets, inserts and deletes active items, updates root, and survives a real preset switch', async () => {
    await handler.handle('risu-set-prompt-preset-item', { index: 0, itemIndex: 0, data: { text: 'revised', role: 'user' } })
    await handler.handle('risu-insert-prompt-preset-item', { index: 0, itemIndex: 1, data: { type: 'memory', innerFormat: 'memo' } })
    expect(DBState.db.promptTemplate).toEqual(DBState.db.botPresets[0].promptTemplate)
    expect(DBState.db.promptTemplate).toHaveLength(2)
    expect(response(await handler.handle('risu-get-prompt-preset', { index: 0 })).items[1]).toMatchObject({ index: 1, type: 'memory', innerFormat: 'memo' })
    await handler.handle('risu-delete-prompt-preset-item', { index: 0, itemIndex: 1 })
    await handler.handle('risu-set-prompt-preset-toggles', { index: 0, text: 'mode=Mode=select=a,b' })
    await handler.handle('risu-set-prompt-preset-field', { index: 0, field: 'mainPrompt', text: 'new main' })
    expect(DBState.db.mainPrompt).toBe('new main')
    expect(DBState.db.customPromptTemplateToggle).toBe('mode=Mode=select=a,b')
    DBState.db.NAIsettings = {}
    changeToPreset(1)
    expect(DBState.db.mainPrompt).toBe('beta main')
    changeToPreset(0)
    expect(DBState.db.promptTemplate[0]).toMatchObject({ text: 'revised', role: 'user' })
    expect(DBState.db.mainPrompt).toBe('new main')
    expect(DBState.db.customPromptTemplateToggle).toBe('mode=Mode=select=a,b')
    expect(access).toHaveBeenCalledTimes(5)
    expect(access.mock.calls[0][1]).toContain('Alpha')
    expect(editBackupCount(session).presets).toBe(1)
  })

  it('edits another preset without touching root fields, then restores both originals', async () => {
    await handler.handle('risu-set-prompt-preset-item', { index: 1, itemIndex: 0, data: { text: 'other' } })
    await handler.handle('risu-insert-prompt-preset-item', { index: 1, itemIndex: 1, data: { type: 'authornote', text: 'note format', role: 'system' } })
    expect(DBState.db.botPresets[1].promptTemplate).toHaveLength(2)
    await handler.handle('risu-delete-prompt-preset-item', { index: 1, itemIndex: 1 })
    await handler.handle('risu-set-prompt-preset-field', { index: 1, field: 'globalNote', text: 'other note' })
    expect(DBState.db.promptTemplate[0].text).toBe('alpha')
    expect(DBState.db.globalNote).toBe('alpha note')
    expect(DBState.db.botPresets[1].promptTemplate[0].text).toBe('other')
    await handler.handle('risu-set-prompt-preset-field', { index: 0, field: 'jailbreak', text: 'changed jail' })
    changeToPreset(1)
    expect(DBState.db.globalNote).toBe('other note')
    expect(restoreEdits(session, DBState.db).presets).toBe(2)
    expect(DBState.db.botPresets[0].jailbreak).toBe('alpha jail')
    expect(DBState.db.globalNote).toBe('beta note')
    expect(DBState.db.botPresets[1].promptTemplate[0].text).toBe('beta')
    expect(DBState.db.botPresets[1].globalNote).toBe('beta note')
    changeToPreset(0)
    expect(DBState.db.jailbreak).toBe('alpha jail')
    expect(editBackupCount(session).presets).toBe(0)
  })

  it('refuses a denied write and keeps the original unrecorded', async () => {
    allowed = false
    expect((await handler.handle('risu-set-prompt-preset-toggles', { index: 0, text: 'x=Y' }) as { text: string }[])[0].text).toMatch(/access denied/)
    expect(DBState.db.customPromptTemplateToggle).toBe('alpha=Label=text')
    expect(editBackupCount(session).presets).toBe(0)
  })
})

describe('edit kind defaults and instructions', () => {
  it('defaults to bot and module, refuses disabling the last one, and splits the guide', () => {
    expect(editKinds()).toEqual({ bot: true, module: true, preset: false })
    expect(risuAccessInstructions()).toContain('Characters are the AI personas')
    expect(risuAccessInstructions()).not.toContain('Prompt presets contain')
    expect(setEditKind('bot', false)).toBe(true)
    expect(risuAccessInstructions()).not.toContain('Folders group characters in the character list')
    expect(setEditKind('module', false)).toBe(false)
    expect(editKinds().module).toBe(true)
    expect(setEditKind('preset', true)).toBe(true)
    expect(setEditKind('module', false)).toBe(true)
    expect(risuAccessInstructions()).toContain('Prompt presets contain')
    expect(risuAccessInstructions()).not.toContain('Regex Scripts are used to replace text')
  })
})
