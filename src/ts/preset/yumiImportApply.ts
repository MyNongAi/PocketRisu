// App side of the Yumi import (see yumiImport.ts for what is carried over).

import { DBState } from 'src/ts/stores.svelte'
import * as pluginStorageStore from 'src/ts/plugins/pluginStorageStore'
import { getOfficialRegistry } from './registry/remote'
import { getBundledRegistryId, loadBundledRegistry } from './registry/loader'
import { resolveSnapshot } from './registry/snapshot'
import { PROMPT_PARAM_READERS } from 'src/ts/process/request/modelPresetBinding'
import { bindingFor, planYumiImport, YUMI_PLUGIN_NAME, YUMI_STORE_KEY, type YumiGenerationSettings } from './yumiImport'

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
 * Create the presets and point every chat at them: the default binding gets
 * the preset matching the model in use, and the model mode is locked to
 * presets. Switching back is the "model mode" setting on the model preset page.
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
    DBState.db.nodeOnlyModelModeLock = 'preset'
    const main = (DBState.db.modelPresets ?? []).find((preset) => preset.id === binding.main)
    return { created: plan.presets.length, updated: plan.updates.length, skipped: plan.skipped, mainName: main?.name }
}
