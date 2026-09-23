// Import Vertex AI models from the Yumi Provider Manager plugin as model presets.
//
// Model presets go through the server's model-job relay, so a reply keeps
// generating after the phone locks or the PC browser closes, and is filled in
// when a page comes back (process/request/jobRecovery.ts). The plugin's
// requests run inside the page and die with it. This carries a Yumi setup
// over: one preset per Vertex model with the same model id, region, thinking
// level, Flex/Priority tier and buffered streaming, and the same service
// account.
//
// The plugin keeps everything in one plugin-storage item, `pm_store`. Only its
// Vertex models are imported; the private key is copied into the preset's
// secret field and never logged.
//
// The plugin did not keep sampling settings of its own: every request took
// temperature, top-p/top-k and the response length from PocketRisu's parameter
// settings, and sent Gemini's safety filters switched off. A model preset
// ignores those settings unless a chat opts in, so the current values are
// written into each preset, and the safety filters with them.

import { v4 as uuidv4 } from 'uuid'
import { emptyModelBinding, type ModelBindingSet, type ModelPreset, type RegistryCache, type ResolvedModelProfileSnapshot } from './types'

export const YUMI_PLUGIN_NAME = 'provider-manager'
export const YUMI_STORE_KEY = 'pm_store'
const VERTEX_PROVIDER = 'vertex-gemini-native'

export interface YumiVertexModel {
    id: string
    name: string
    modelId: string
    groupName: string
    region: string
    serviceTier?: 'flex' | 'priority'
    thinkingLevel?: string
    /** Buffer a streamed reply and show it at once (Yumi's "decoupled" request). */
    decoupled: boolean
    credential?: { projectId: string, clientEmail: string, privateKey: string }
}

function parseStore(store: unknown): any {
    let value = store
    for (let i = 0; i < 2 && typeof value === 'string'; i++) {
        try { value = JSON.parse(value) } catch { return null }
    }
    return value && typeof value === 'object' ? value : null
}

/** The enabled Vertex models in a Yumi `pm_store`, with their credentials. */
export function readYumiVertexModels(store: unknown): YumiVertexModel[] {
    const root = parseStore(store)
    if (!root || !Array.isArray(root.models)) return []
    const groups = new Map<string, string>((root.modelGroups ?? []).map((group: any) => [group?.id, group?.name ?? '']))
    const keys: any[] = Array.isArray(root.keys) ? root.keys : Object.values(root.keys ?? {})

    const models: YumiVertexModel[] = []
    for (const model of root.models) {
        if (!model || model.enabled === false || model.platform !== 'vertex' || typeof model.modelId !== 'string') continue
        const key = keys.find((candidate) => candidate?.id === model.keyId && candidate?.type === 'vertex')
        const tier = String(model.provider?.vertexServiceTier ?? '').toLowerCase()
        models.push({
            id: String(model.id ?? model.modelId),
            name: String(model.name ?? model.modelId),
            modelId: model.modelId,
            groupName: groups.get(model.groupId) ?? '',
            region: typeof model.vertexRegion === 'string' && model.vertexRegion ? model.vertexRegion : 'global',
            serviceTier: tier === 'flex' || tier === 'priority' ? tier : undefined,
            thinkingLevel: typeof model.provider?.thinkingLevel === 'string' ? model.provider.thinkingLevel.toLowerCase() : undefined,
            decoupled: model.request?.decoupled === true,
            credential: key?.clientEmail && key?.privateKey
                ? { projectId: String(key.projectId ?? ''), clientEmail: String(key.clientEmail), privateKey: String(key.privateKey) }
                : undefined,
        })
    }
    return models
}

/** Rebuild a service-account JSON from the three fields Yumi stores. */
export function serviceAccountJson(credential: NonNullable<YumiVertexModel['credential']>): string {
    return JSON.stringify({
        type: 'service_account',
        project_id: credential.projectId,
        client_email: credential.clientEmail,
        private_key: credential.privateKey,
        token_uri: 'https://oauth2.googleapis.com/token',
    })
}

/** "[PM] gemini-3.7-flash (Vertex AI 5)" is how the plugin names its models. */
export function matchesClassicModel(model: YumiVertexModel, classicModelId: string | undefined): boolean {
    if (!classicModelId?.startsWith('pluginmodel:::')) return false
    const label = classicModelId.slice('pluginmodel:::'.length)
    return label.includes(model.name) && (!model.groupName || label.includes(`(${model.groupName})`))
}

function findVertexProfile(registry: RegistryCache, modelId: string): string | null {
    for (const entry of Object.values(registry.registries ?? {})) {
        for (const profile of Object.values(entry.profiles ?? {})) {
            if (profile?.providerBaseId === VERTEX_PROVIDER && profile.modelId === modelId) return profile.id
        }
    }
    return null
}

/**
 * For a model id with no profile of its own (a newer model than the registry
 * knows), borrow the newest Vertex Gemini profile and override the model id.
 * Only profiles that assemble the Vertex URL qualify; the old generic ones
 * carry an empty static endpoint and cannot send anything.
 */
function findFallbackProfile(registry: RegistryCache): string | null {
    let best: { id: string, updatedAt: number } | null = null
    for (const entry of Object.values(registry.registries ?? {})) {
        for (const profile of Object.values(entry.profiles ?? {})) {
            if (profile?.providerBaseId !== VERTEX_PROVIDER || profile.endpoint?.kind !== 'vertex-gemini') continue
            const updatedAt = Number(profile.updatedAt ?? 0)
            if (!best || updatedAt > best.updatedAt) best = { id: profile.id, updatedAt }
        }
    }
    return best?.id ?? null
}

/**
 * Make the three choices the plugin made easy just as easy here: the tier
 * shows without opening the advanced section, and every imported model id is
 * in the model list.
 */
function tuneSnapshot(snapshot: ResolvedModelProfileSnapshot, modelIds: readonly string[]): ResolvedModelProfileSnapshot {
    const tuned = structuredClone(snapshot)
    for (const field of tuned.uiSchema?.fields ?? []) {
        if (field.key === 'sharedRequestType' || field.key === 'thinkingLevel' || field.key === 'modelId') {
            field.visibility = 'basic'
        }
    }
    const modelField = tuned.schema.find((field) => field.key === 'modelId')
    if (modelField) {
        const known = new Set((modelField.enum ?? []).map((option) => String(option.value)))
        const added = modelIds.filter((id) => !known.has(id)).map((id) => ({ value: id, label: id }))
        modelField.enum = [...added, ...(modelField.enum ?? [])]
    }
    return tuned
}

/** What the plugin sent as safetySettings on every Vertex request. */
export const YUMI_SAFETY_OFF = [
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_DANGEROUS_CONTENT',
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_CIVIC_INTEGRITY',
].map((category) => ({ category, threshold: 'OFF' }))

/** Generation settings the plugin read from PocketRisu at request time. */
export interface YumiGenerationSettings {
    /** Values keyed by preset field (temperature, topP, topK, ...), already on the wire scale. */
    sampling: Record<string, number>
    maxOutputTokens?: number
}

/** The generation values a preset built on `snapshot` should carry. */
function generationValues(snapshot: ResolvedModelProfileSnapshot, generation?: YumiGenerationSettings): Record<string, unknown> {
    const values: Record<string, unknown> = {}
    for (const field of snapshot.schema) {
        if (field.mapsTo?.target !== 'body') continue
        const sampled = generation?.sampling[field.key]
        if (typeof sampled === 'number' && Number.isFinite(sampled)) values[field.key] = sampled
    }
    const has = (key: string) => snapshot.schema.some((field) => field.key === key)
    if (generation?.maxOutputTokens && generation.maxOutputTokens > 0 && has('maxOutputTokens')) {
        values.maxOutputTokens = generation.maxOutputTokens
    }
    if (has('safetySettings')) values.safetySettings = YUMI_SAFETY_OFF
    return values
}

/**
 * For a preset imported before generation settings were carried over: fill
 * what it lacks, and replace a response length still at the profile default.
 * Anything the user set by hand is left alone.
 */
function missingGenerationValues(preset: ModelPreset, generation?: YumiGenerationSettings): Record<string, unknown> {
    const wanted = generationValues(preset.profileSnapshot, generation)
    const current = preset.userValues ?? {}
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(wanted)) {
        const field = preset.profileSnapshot.schema.find((candidate) => candidate.key === key)
        const unset = current[key] === undefined
        const atDefault = key === 'maxOutputTokens' && field?.default !== undefined && current[key] === field.default
        if (unset || atDefault) patch[key] = value
    }
    return patch
}

export interface YumiImportPlan {
    presets: ModelPreset[]
    /** Already imported presets that get the generation values they lack. */
    updates: { id: string, values: Record<string, unknown> }[]
    /** Preset matching the model the classic settings use now, if any. */
    mainPresetId?: string
    subPresetId?: string
    skipped: string[]
}

/**
 * Work out the presets to create. Models already imported (same Yumi model
 * id) are skipped, so running the import again only adds what is new.
 */
export function planYumiImport(args: {
    store: unknown
    registries: RegistryCache[]
    registryId: string
    resolveSnapshot: (registry: RegistryCache, profileId: string) => ResolvedModelProfileSnapshot
    existing: readonly ModelPreset[]
    classicMain?: string
    classicSub?: string
    generation?: YumiGenerationSettings
    now?: number
}): YumiImportPlan {
    const now = args.now ?? Date.now()
    const models = readYumiVertexModels(args.store)
    const modelIds = models.map((model) => model.modelId)
    const plan: YumiImportPlan = { presets: [], updates: [], skipped: [] }

    const alreadyImported = (model: YumiVertexModel) => args.existing.find((preset) =>
        preset.migrationSource?.sourceKind === 'yumi-provider-manager' && preset.migrationSource.sourcePath === `models/${model.id}`)

    for (const model of models) {
        const previous = alreadyImported(model)
        if (previous) {
            plan.skipped.push(model.name)
            const values = missingGenerationValues(previous, args.generation)
            if (Object.keys(values).length > 0) plan.updates.push({ id: previous.id, values })
            if (matchesClassicModel(model, args.classicMain)) plan.mainPresetId ??= previous.id
            if (matchesClassicModel(model, args.classicSub)) plan.subPresetId ??= previous.id
            continue
        }

        let registry: RegistryCache | undefined
        let profileId: string | null = null
        for (const candidate of args.registries) {
            profileId = findVertexProfile(candidate, model.modelId)
            if (profileId) { registry = candidate; break }
        }
        if (!registry || !profileId) {
            for (const candidate of args.registries) {
                profileId = findFallbackProfile(candidate)
                if (profileId) { registry = candidate; break }
            }
        }
        if (!registry || !profileId) {
            plan.skipped.push(model.name)
            continue
        }

        const snapshot = tuneSnapshot(args.resolveSnapshot(registry, profileId), modelIds)
        const userValues: Record<string, unknown> = {}
        for (const field of snapshot.schema) {
            if (field.default !== undefined) userValues[field.key] = field.default
        }
        Object.assign(userValues, generationValues(snapshot, args.generation))
        userValues.location = model.region
        userValues.modelId = model.modelId
        if (model.thinkingLevel) userValues.thinkingLevel = model.thinkingLevel
        if (model.serviceTier) userValues.sharedRequestType = model.serviceTier
        if (model.credential) {
            userValues.serviceAccountJson = serviceAccountJson(model.credential)
            if (model.credential.projectId) userValues.projectId = model.credential.projectId
        }

        const preset: ModelPreset = {
            id: uuidv4(),
            name: model.groupName ? `${model.groupName} · ${model.name}` : model.name,
            profileSnapshot: snapshot,
            sourceProfile: {
                registryId: args.registryId,
                profileId: snapshot.profileId,
                profileVersion: snapshot.profileVersion,
                providerBaseVersion: snapshot.providerBaseVersion,
                fetchedAt: now,
            },
            migrationSource: { sourceKind: 'yumi-provider-manager', sourcePath: `models/${model.id}`, configHash: model.modelId },
            userValues,
            useStreaming: true,
            decoupledStreaming: model.decoupled,
            createdAt: now,
            updatedAt: now,
        } as ModelPreset
        plan.presets.push(preset)
        if (matchesClassicModel(model, args.classicMain)) plan.mainPresetId ??= preset.id
        if (matchesClassicModel(model, args.classicSub)) plan.subPresetId ??= preset.id
    }
    return plan
}

/** Default binding that sends every chat to the imported presets. */
export function bindingFor(plan: YumiImportPlan, current?: ModelBindingSet): ModelBindingSet | null {
    const main = plan.mainPresetId ?? plan.presets[0]?.id
    if (!main) return null
    return {
        ...emptyModelBinding(),
        ...(current ?? {}),
        main,
        sub: plan.subPresetId ?? main,
    }
}
