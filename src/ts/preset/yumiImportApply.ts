// App side of the Yumi import (see yumiImport.ts for what is carried over).

import { DBState } from 'src/ts/stores.svelte'
import * as pluginStorageStore from 'src/ts/plugins/pluginStorageStore'
import { getOfficialRegistry } from './registry/remote'
import { getBundledRegistryId, loadBundledRegistry } from './registry/loader'
import { resolveSnapshot } from './registry/snapshot'
import { PROMPT_PARAM_READERS } from 'src/ts/process/request/modelPresetBinding'
import { bindingFor, planYumiImport, YUMI_PLUGIN_NAME, YUMI_STORE_KEY, type YumiGenerationSettings } from './yumiImport'
import { modelPresetIdOf, modelPresetPickerId } from './pickerId'

/** The parameter settings the plugin sent with every request. */
function currentGenerationSettings(): YumiGenerationSettings {
    const db = DBState.db
    const sampling: Record<string, number> = {}
    for (const [key, read] of Object.entries(PROMPT_PARAM_READERS)) {
        const value = read(db)
        if (typeof value === 'number' && Number.isFinite(value) && value !== -1000) sampling[key] = value
    }
    return { sampling, maxOutputTokens: db.maxResponse > 0 ? db.maxResponse : undefined }
}

export function hasYumiPlugin(): boolean {
    return (DBState.db.plugins ?? []).some((plugin) => plugin?.name === YUMI_PLUGIN_NAME)
}

export interface YumiImportResult {
    created: number
    /** Presets from an earlier import that got missing generation settings. */
    updated: number
    skipped: string[]
    /** Name of the preset every chat now uses, when the switch happened. */
    mainName?: string
}

/**
 * Create the presets and select the one matching the model in use in the
 * ordinary model picker (main and sub), where presets now sit next to the
 * built-in and plugin models. The model mode goes back to the picker
 * ('legacy'): no separate preset mode is needed, and the picker shows what
 * is actually used. A picker that already holds a preset is left alone.
 */
export async function importFromYumi(): Promise<YumiImportResult> {
    const store = await pluginStorageStore.getItem(YUMI_STORE_KEY)
    if (!store) return { created: 0, updated: 0, skipped: [] }

    const plan = planYumiImport({
        store,
        registries: [getOfficialRegistry(), loadBundledRegistry()],
        registryId: getBundledRegistryId(),
        resolveSnapshot,
        existing: DBState.db.modelPresets ?? [],
        classicMain: DBState.db.aiModel,
        classicSub: DBState.db.subModel,
        generation: currentGenerationSettings(),
    })

    for (const update of plan.updates) {
        const preset = (DBState.db.modelPresets ?? []).find((candidate) => candidate.id === update.id)
        if (preset) preset.userValues = { ...(preset.userValues ?? {}), ...update.values }
    }
    if (plan.presets.length > 0) {
        DBState.db.modelPresets = [...(DBState.db.modelPresets ?? []), ...plan.presets]
    }
    const binding = bindingFor(plan, DBState.db.defaultModelBinding)
    if (!binding) return { created: plan.presets.length, updated: plan.updates.length, skipped: plan.skipped }

    DBState.db.defaultModelBinding = binding
    if (modelPresetIdOf(DBState.db.aiModel) === null && binding.main) {
        DBState.db.aiModel = modelPresetPickerId(binding.main)
    }
    if (modelPresetIdOf(DBState.db.subModel) === null && binding.sub) {
        DBState.db.subModel = modelPresetPickerId(binding.sub)
    }
    DBState.db.nodeOnlyModelModeLock = 'legacy'
    const mainId = modelPresetIdOf(DBState.db.aiModel) ?? binding.main
    const main = (DBState.db.modelPresets ?? []).find((preset) => preset.id === mainId)
    return { created: plan.presets.length, updated: plan.updates.length, skipped: plan.skipped, mainName: main?.name }
}
