export type AdapterKind =
    | 'openai-compatible'
    | 'anthropic-messages'
    | 'google-gemini'

export type AuthKind =
    | 'none'
    | 'bearer'
    | 'x-api-key'
    | 'query'
    | 'google-service-account'

export type EndpointKind =
    | 'static'
    | 'vertex-openai'

export type RegistryFieldType =
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'json'
    | 'stringArray'
    | 'keyValue'

export type RegistryWidget =
    | 'text'
    | 'secret'
    | 'textarea'
    | 'number-input'
    | 'slider'
    | 'select'
    | 'segmented'
    | 'toggle'
    | 'json'
    | 'key-value'

export type UiVisibility = 'basic' | 'advanced' | 'hidden'

export type RegistryMappingTarget =
    | 'body'
    | 'header'
    | 'query'
    | 'auth'
    | 'custom'

export interface RegistryMapping {
    target: RegistryMappingTarget
    path: string
}

export interface RegistryFieldSchema {
    key: string
    type: RegistryFieldType
    label: string
    description?: string
    default?: unknown
    enum?: Array<{ value: string | number | boolean; label: string }>
    min?: number
    max?: number
    step?: number
    required?: boolean
    secret?: boolean
    mapsTo?: RegistryMapping
}

export interface RegistrySimpleCondition {
    key: string
    equals?: unknown
    notEquals?: unknown
}

export interface RegistryUiField {
    key: string
    widget: RegistryWidget
    visibility: UiVisibility
    group?: string
    order?: number
    placeholder?: string
    help?: string
    showIf?: RegistrySimpleCondition
}

export interface RegistryUiSchema {
    groups: Array<{ id: string; label: string; order?: number }>
    fields: RegistryUiField[]
}

export interface RegistryEndpoint {
    kind: EndpointKind
    url?: string
}

export interface RegistryAuth {
    kind: AuthKind
    fields?: string[]
}

export type RegistryCapability =
    | 'streaming'
    | 'vision'
    | 'tools'
    | 'json'
    | 'reasoning'

export interface BaseProviderDefinition {
    id: string
    version: number
    displayName: string
    adapterKind: AdapterKind
    authKinds: AuthKind[]
    endpointKinds: EndpointKind[]
    defaultHeaders?: Record<string, string>
    defaultBody?: Record<string, unknown>
    requestSchema: RegistryFieldSchema[]
    uiSchema: RegistryUiSchema
    capabilities?: RegistryCapability[]
    sourceUrls: string[]
}

export interface ModelProfile {
    id: string
    version: number
    displayName: string
    providerBaseId: string
    profileTier: 'standard'
    description?: string
    modelId: string
    endpoint: RegistryEndpoint
    auth: RegistryAuth
    defaults: Record<string, unknown>
    schema: RegistryFieldSchema[]
    uiSchema: RegistryUiSchema
    bodyTemplate?: Record<string, unknown>
    headerTemplate?: Record<string, string>
    capabilities?: RegistryCapability[]
    sourceUrls: string[]
}

export interface ModelPresetSourceProfile {
    registryId: string
    profileId: string
    profileVersion: number
    fetchedAt: number
}

export interface ResolvedModelProfileSnapshot {
    profileId: string
    profileVersion: number
    providerBaseId: string
    adapterKind: AdapterKind
    auth: RegistryAuth
    endpoint: RegistryEndpoint
    modelId: string
    schema: RegistryFieldSchema[]
    uiSchema: RegistryUiSchema
    defaults: Record<string, unknown>
    bodyTemplate?: Record<string, unknown>
    headerTemplate?: Record<string, string>
    capabilities?: RegistryCapability[]
}

export interface ModelPreset {
    id: string
    name: string
    notes?: string
    sourceProfile?: ModelPresetSourceProfile
    profileSnapshot: ResolvedModelProfileSnapshot
    userValues: Record<string, unknown>
    orphanValues?: Record<string, unknown>
    apiKeyRef?: string
    inlineCredential?: unknown
    fallbackModelPresetIds?: string[]
    pinned?: boolean
    order?: number
    createdAt: number
    updatedAt: number
}

export type ModelBinding =
    | { kind: 'modelPreset'; id: string }
    | { kind: 'pluginModel'; id: string }
    | { kind: 'manualRequired'; reason: string; legacySource?: string }
    | { kind: 'none' }

export type ResolvedTask =
    | 'model'
    | 'submodel'
    | 'memory'
    | 'emotion'
    | 'translate'
    | 'otherAx'

export type TaskModelBindings = Partial<Record<ResolvedTask, ModelBinding>>

export interface ModelBindingFields {
    modelBinding?: ModelBinding
    subModelBinding?: ModelBinding
    taskModelBindings?: TaskModelBindings
}

export interface ApiKeyPoolEntry {
    id: string
    name: string
    provider?: string
    key: string
    createdAt: number
    updatedAt: number
}

export interface RegistryCache {
    schemaVersion: 4
    registries: Record<string, {
        fetchedAt: number
        indexVersion?: number
        profiles?: Record<string, ModelProfile>
        baseProviders?: Record<string, BaseProviderDefinition>
    }>
}

export interface ModelPresetMigrationSummary {
    version: number
    appliedAt: number
    createdModelPresetCount: number
    botPresetBindingCount: number
    chatBindingCount: number
    pluginBindingCount: number
    manualRequiredCount: number
    skippedBiasCount: number
    warnings: string[]
}
