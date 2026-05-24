import type { ApiKeyPoolEntry, ModelPreset, ModelPresetMigrationSummary, RegistryCache } from './types'

export interface ModelPresetDefaultsTarget {
    modelPresets?: ModelPreset[]
    modelPresetMigrationVersion?: number
    modelPresetMigrationAppliedAt?: number
    modelPresetMigrationReport?: ModelPresetMigrationSummary
    apiKeyPool?: Record<string, ApiKeyPoolEntry>
    modelProfileRegistryCache?: RegistryCache
    modelProfileRegistryLastFetched?: number
}

export function createEmptyRegistryCache(): RegistryCache {
    return {
        schemaVersion: 4,
        registries: {},
    }
}

export function applyModelPresetDefaults(data: ModelPresetDefaultsTarget): void {
    if (!Array.isArray(data.modelPresets)) {
        data.modelPresets = []
    }
    if (!data.apiKeyPool || typeof data.apiKeyPool !== 'object' || Array.isArray(data.apiKeyPool)) {
        data.apiKeyPool = {}
    }
    if (!data.modelProfileRegistryCache || data.modelProfileRegistryCache.schemaVersion !== 4) {
        data.modelProfileRegistryCache = createEmptyRegistryCache()
    }
    data.modelProfileRegistryLastFetched ??= 0
}
