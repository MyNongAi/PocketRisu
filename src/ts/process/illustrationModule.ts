// The 🎨 illustration module (the user's request, 2026-10-26): one module at
// the top of the module list holds the style presets ("프리셋 X" lorebook
// entries, illustration.ts) every bot can pick, on or off. A new preset and
// one taken from a dropped image go there, not into a bot's lorebook. The
// app-wide list the presets lived in until 2026-10-20
// (`nodeOnlyIllustrationPresets`, left in the save as it is) is restored into
// it once. Found by its marker, so renaming it is fine.
import type { loreBook } from '../storage/database.svelte'
import type { RisuModule } from './modules'
import { lorebookPresets, parsePresetEntry, presetFolderContent, presetSectionsOf, PRESET_NAI_HINT, type PresetSections } from './illustration'
import { recordModuleActivation, seedModuleActivationHistory } from './moduleSort'

/** An entry of the old app-wide preset list. */
export interface LegacyIllustrationPreset {
    id?: string
    name?: string
    positive?: string
    negative?: string
}

export interface IllustrationModuleDb {
    modules: RisuModule[]
    enabledModules?: string[]
    moduleActivationHistory?: string[]
    nodeOnlyIllustrationPresets?: LegacyIllustrationPreset[]
    nodeOnlyIllustrationPresetsRestored?: boolean
    nodeOnlyIllustrationPresetsFoldered?: boolean
}

/** How a missing module is made: its id, the name and description to show, and when. */
export interface IllustrationModuleMake {
    id: () => string
    name: string
    description: string
    now: number
}

export function illustrationModuleOf(db: { modules?: readonly (RisuModule | null | undefined)[] }): RisuModule | undefined {
    return db.modules?.find((module) => !!module?.nodeOnlyIllustrationModule) ?? undefined
}

/** A "프리셋 X" entry, never active in the main prompt (no keys, not always on). */
export function presetLorebookEntry(name: string, content: string): loreBook {
    return {
        key: '', secondkey: '', insertorder: 100, comment: `프리셋 ${name}`,
        content, mode: 'normal', alwaysActive: false, selective: false,
    }
}

/** A lorebook folder key as the lorebook's own "new folder" makes it. */
export function presetFolderKey(id: string): string {
    return 'folder:' + id
}

/**
 * A "프리셋 X" folder (the user's choice, 2026-10-28): the folder, then its
 * Positive, Negative and NAI entries, none ever active in the main prompt.
 */
export function presetLorebookFolder(name: string, sections: PresetSections, folderKey: string): loreBook[] {
    const inside = (comment: string, content: string): loreBook => ({
        key: '', secondkey: '', insertorder: 100, comment, content,
        mode: 'normal', alwaysActive: false, selective: false, folder: folderKey,
    })
    return [
        { key: folderKey, secondkey: '', insertorder: 100, comment: `프리셋 ${name}`, content: '', mode: 'folder', alwaysActive: false, selective: false },
        inside('Positive', sections.positive),
        inside('Negative', sections.negative),
        inside('NAI', sections.nai),
    ]
}

/** An old app-wide preset as a folder's entries; {prompt} stays where it was (none: the scene goes first). */
export function legacyPresetSections(preset: LegacyIllustrationPreset): PresetSections {
    return { positive: (preset.positive ?? '').trim(), negative: (preset.negative ?? '').trim(), nai: PRESET_NAI_HINT }
}

/** The preset names a lorebook already has, folders and one-entry presets alike. */
function presetNames(lorebook: readonly loreBook[] | undefined): Set<string> {
    return new Set(lorebookPresets([{ label: '', entries: lorebook }]).map((preset) => preset.name))
}

function liftToNewest(db: IllustrationModuleDb, id: string): void {
    db.moduleActivationHistory = recordModuleActivation(
        seedModuleActivationHistory(db.moduleActivationHistory, db.enabledModules),
        id,
    )
}

/**
 * The illustration module, made when there is none: top level (no folder),
 * newest in the module list. Returns the database's own copy (on a $state
 * database, the proxy), so writes to it are seen.
 */
export function ensureIllustrationModule(db: IllustrationModuleDb, make: IllustrationModuleMake): RisuModule {
    const found = illustrationModuleOf(db)
    if (found) return found
    db.modules.push({
        name: make.name,
        description: make.description,
        id: make.id(),
        lorebook: [],
        importedAt: make.now,
        nodeOnlyIllustrationModule: true,
    })
    const module = db.modules[db.modules.length - 1]
    liftToNewest(db, module.id)
    return module
}

/**
 * Once per save: the old app-wide presets as "프리셋 X" entries of the
 * illustration module (made if missing), skipping names it already has; the
 * module goes to the top of the list. Returns how many were added.
 */
export function restoreIllustrationPresetsOnce(db: IllustrationModuleDb, make: IllustrationModuleMake): number {
    if (db.nodeOnlyIllustrationPresetsRestored) return 0
    const legacy = (Array.isArray(db.nodeOnlyIllustrationPresets) ? db.nodeOnlyIllustrationPresets : [])
        .filter((preset) => !!preset && typeof preset.name === 'string' && !!preset.name.trim())
    if (legacy.length === 0) {
        db.nodeOnlyIllustrationPresetsRestored = true
        return 0
    }
    const module = ensureIllustrationModule(db, make)
    const taken = presetNames(module.lorebook)
    const added: loreBook[] = []
    let count = 0
    for (const preset of legacy) {
        const name = preset.name!.trim()
        if (taken.has(name)) continue
        taken.add(name)
        added.push(...presetLorebookFolder(name, legacyPresetSections(preset), presetFolderKey(make.id())))
        count++
    }
    if (added.length > 0) module.lorebook = [...(module.lorebook ?? []), ...added]
    liftToNewest(db, module.id)
    db.nodeOnlyIllustrationPresetsRestored = true
    return count
}

/**
 * Once per save (the user's choice, 2026-10-28): each one-entry "프리셋 X" of
 * the 🎨 module becomes a folder (Positive, Negative, NAI) where it stood.
 * The old entry stays, renamed so it is no longer read as a preset. Returns
 * how many were made.
 */
export function folderIllustrationPresetsOnce(db: IllustrationModuleDb, make: IllustrationModuleMake): number {
    if (db.nodeOnlyIllustrationPresetsFoldered) return 0
    const module = illustrationModuleOf(db)
    if (!module) {
        db.nodeOnlyIllustrationPresetsFoldered = true
        return 0
    }
    const lorebook = module.lorebook ?? []
    const folderNames = new Set(lorebook
        .filter((entry) => entry?.mode === 'folder')
        .map((entry) => parsePresetEntry(entry.comment ?? '', presetFolderContent(entry.key, lorebook))?.name)
        .filter(Boolean))
    const next: loreBook[] = []
    let made = 0
    for (const entry of lorebook) {
        const preset = entry && entry.mode !== 'folder' ? parsePresetEntry(entry.comment ?? '', entry.content ?? '') : null
        const sections = preset ? presetSectionsOf(entry.content ?? '') : null
        if (!preset || !sections || folderNames.has(preset.name)) {
            next.push(entry)
            continue
        }
        folderNames.add(preset.name)
        next.push(...presetLorebookFolder(preset.name, sections, presetFolderKey(make.id())))
        next.push({ ...entry, comment: `(폴더로 옮김) ${entry.comment}` })
        made++
    }
    if (made > 0) module.lorebook = next
    db.nodeOnlyIllustrationPresetsFoldered = true
    return made
}
