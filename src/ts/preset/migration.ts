import { LLMFormat } from '../model/types'
import type {
    ManualMigrationItem,
    MigrationBindingScope,
    MigrationReport,
    ModelBinding,
    PlannedModelPreset,
    ResolvedTask,
} from './types'

type LegacyCustomModel = {
    id: string
    internalId?: string
    url?: string
    format?: number
    key?: string
    name?: string
    params?: string
    flags?: number[]
}

type LegacyTaskModels = {
    memory?: string
    emotion?: string
    translate?: string
    otherAx?: string
}

type LegacyFallbackModels = {
    memory?: string[]
    emotion?: string[]
    translate?: string[]
    otherAx?: string[]
    model?: string[]
}

type LegacyBotPreset = {
    id?: string
    name?: string
    aiModel?: string
    subModel?: string
    forceReplaceUrl?: string
    proxyKey?: string
    openAIKey?: string
    proxyRequestModel?: string
    openrouterRequestModel?: string
    nanogptRequestModel?: string
    customProxyRequestModel?: string
    customAPIFormat?: number
    currentPluginProvider?: string
    bias?: [string, number][]
    customFlags?: number[]
    enableCustomFlags?: boolean
    seperateModelsForAxModels?: boolean
    seperateModels?: LegacyTaskModels
    fallbackModels?: LegacyFallbackModels
}

export type ModelPresetMigrationInput = {
    aiModel?: string
    subModel?: string
    forceReplaceUrl?: string
    proxyKey?: string
    openAIKey?: string
    openrouterKey?: string
    nanogptKey?: string
    claudeAPIKey?: string
    proxyRequestModel?: string
    openrouterRequestModel?: string
    nanogptRequestModel?: string
    customProxyRequestModel?: string
    customAPIFormat?: number
    additionalParams?: [string, string][]
    currentPluginProvider?: string
    bias?: [string, number][]
    customFlags?: number[]
    enableCustomFlags?: boolean
    customModels?: LegacyCustomModel[]
    botPresets?: LegacyBotPreset[]
    seperateModelsForAxModels?: boolean
    seperateModels?: LegacyTaskModels
    fallbackModels?: LegacyFallbackModels
    modelTools?: string[]
    presetChain?: string
}

type ProfileResolution =
    | { kind: 'profile'; profileId: string; modelId?: string; credentialPath?: string }
    | { kind: 'plugin'; pluginModelId: string }
    | { kind: 'manual'; reason: string }
    | { kind: 'none' }

type BindingTarget = {
    scope: MigrationBindingScope
    ownerId?: string
    targetTask: ResolvedTask
    sourcePath: string
}

export function analyzeModelPresetMigration(db: ModelPresetMigrationInput): MigrationReport {
    const report: MigrationReport = {
        version: 1,
        createdModelPresets: [],
        globalBindings: [],
        botPresetBindings: [],
        chatBindings: [],
        pluginBindings: [],
        manualRequired: [],
        skippedBias: [],
        preservedLegacyFields: [],
        warnings: [],
    }
    const plannedById = new Map<string, PlannedModelPreset>()

    const addPreset = (preset: PlannedModelPreset) => {
        plannedById.set(preset.id, preset)
    }

    for (const [index, customModel] of (db.customModels ?? []).entries()) {
        const sourcePath = `customModels.${customModel.id || index}`
        const profileId = profileForFormat(customModel.format)
        if (!profileId) {
            addManual(report, sourcePath, `Unsupported custom model format: ${customModel.format}`, customModel.id)
            continue
        }
        addPreset(createPlannedPreset({
            sourceKind: 'custom',
            sourcePath,
            profileId,
            name: customModel.name || customModel.id || `Custom Model ${index + 1}`,
            endpointUrl: customModel.url || '',
            modelId: customModel.internalId || customModel.id,
            credentialPath: customModel.key ? `${sourcePath}.key` : undefined,
            userValues: {
                endpointUrl: customModel.url || '',
                modelId: customModel.internalId || customModel.id,
                params: redactFreeform(customModel.params || ''),
                flags: cloneArray(customModel.flags ?? []),
            },
        }))
    }

    if (hasReverseProxyConfig(db)) {
        addReverseProxyPreset(report, plannedById, {
            sourceKind: 'reverse-proxy',
            sourcePath: 'db.reverse_proxy',
            name: 'Migrated Reverse Proxy',
            forceReplaceUrl: db.forceReplaceUrl,
            requestModel: db.customProxyRequestModel || db.proxyRequestModel,
            proxyKeyPath: db.proxyKey ? 'db.proxyKey' : undefined,
            customAPIFormat: db.customAPIFormat,
            additionalParams: db.additionalParams,
        })
    }

    addGlobalBindings(report, plannedById, db)
    addBotPresetBindings(report, plannedById, db)
    addDeprecatedItems(report, db)

    report.createdModelPresets = Array.from(plannedById.values())
    return report
}

function addGlobalBindings(
    report: MigrationReport,
    plannedById: Map<string, PlannedModelPreset>,
    db: ModelPresetMigrationInput,
): void {
    if (db.aiModel) {
        pushBinding(report, {
            scope: 'global',
            targetTask: 'model',
            sourcePath: 'db.aiModel',
        }, bindingForLegacyModel({
            model: db.aiModel,
            sourcePath: 'db.aiModel',
            plannedById,
            db,
        }))
    }
    if (db.subModel) {
        pushBinding(report, {
            scope: 'global',
            targetTask: 'submodel',
            sourcePath: 'db.subModel',
        }, bindingForLegacyModel({
            model: db.subModel,
            sourcePath: 'db.subModel',
            plannedById,
            db,
        }))
    }
    if (db.seperateModelsForAxModels && db.seperateModels) {
        addTaskBindings(report, plannedById, db, db.seperateModels, 'global', undefined, 'db.seperateModels')
    }
}

function addBotPresetBindings(
    report: MigrationReport,
    plannedById: Map<string, PlannedModelPreset>,
    db: ModelPresetMigrationInput,
): void {
    for (const [index, preset] of (db.botPresets ?? []).entries()) {
        const ownerId = preset.id || String(index)
        const sourcePrefix = `botPresets.${ownerId}`

        if (hasPresetReverseProxyConfig(preset)) {
            // Create the preset before resolving bindings so reverse_proxy
            // bindings can link to the planned ModelPreset by source path.
            addReverseProxyPreset(report, plannedById, {
                sourceKind: 'bot-preset-reverse-proxy',
                sourcePath: `${sourcePrefix}.reverse_proxy`,
                name: `Migrated ${preset.name || ownerId} Reverse Proxy`,
                forceReplaceUrl: preset.forceReplaceUrl,
                requestModel: preset.customProxyRequestModel || preset.proxyRequestModel,
                proxyKeyPath: preset.proxyKey ? `${sourcePrefix}.proxyKey` : undefined,
                customAPIFormat: preset.customAPIFormat,
                additionalParams: undefined,
            })
        }

        if (preset.aiModel) {
            pushBinding(report, {
                scope: 'botPreset',
                ownerId,
                targetTask: 'model',
                sourcePath: `${sourcePrefix}.aiModel`,
            }, bindingForLegacyModel({
                model: preset.aiModel,
                sourcePath: `${sourcePrefix}.aiModel`,
                plannedById,
                db,
                botPreset: preset,
            }))
        }
        if (preset.subModel) {
            pushBinding(report, {
                scope: 'botPreset',
                ownerId,
                targetTask: 'submodel',
                sourcePath: `${sourcePrefix}.subModel`,
            }, bindingForLegacyModel({
                model: preset.subModel,
                sourcePath: `${sourcePrefix}.subModel`,
                plannedById,
                db,
                botPreset: preset,
            }))
        }
        if (preset.seperateModelsForAxModels && preset.seperateModels) {
            addTaskBindings(report, plannedById, db, preset.seperateModels, 'botPreset', ownerId, `${sourcePrefix}.seperateModels`, preset)
        }
    }
}

function addTaskBindings(
    report: MigrationReport,
    plannedById: Map<string, PlannedModelPreset>,
    db: ModelPresetMigrationInput,
    taskModels: LegacyTaskModels,
    scope: MigrationBindingScope,
    ownerId: string | undefined,
    sourcePrefix: string,
    botPreset?: LegacyBotPreset,
): void {
    const taskEntries: Array<[ResolvedTask, string | undefined]> = [
        ['memory', taskModels.memory],
        ['emotion', taskModels.emotion],
        ['translate', taskModels.translate],
        ['otherAx', taskModels.otherAx],
    ]
    for (const [targetTask, model] of taskEntries) {
        if (!model) continue
        pushBinding(report, {
            scope,
            ownerId,
            targetTask,
            sourcePath: `${sourcePrefix}.${targetTask}`,
        }, bindingForLegacyModel({
            model,
            sourcePath: `${sourcePrefix}.${targetTask}`,
            plannedById,
            db,
            botPreset,
        }))
    }
}

function addReverseProxyPreset(
    report: MigrationReport,
    plannedById: Map<string, PlannedModelPreset>,
    args: {
        sourceKind: string
        sourcePath: string
        name: string
        forceReplaceUrl?: string
        requestModel?: string
        proxyKeyPath?: string
        customAPIFormat?: number
        additionalParams?: [string, string][]
    },
): void {
    const profileId = profileForFormat(args.customAPIFormat ?? LLMFormat.OpenAICompatible)
    if (!profileId) {
        addManual(report, args.sourcePath, `Unsupported reverse proxy format: ${args.customAPIFormat}`, 'reverse_proxy')
        return
    }
    const planned = createPlannedPreset({
        sourceKind: args.sourceKind,
        sourcePath: args.sourcePath,
        profileId,
        name: args.name,
        endpointUrl: args.forceReplaceUrl || '',
        modelId: args.requestModel || 'reverse_proxy',
        credentialPath: args.proxyKeyPath,
        userValues: {
            endpointUrl: args.forceReplaceUrl || '',
            modelId: args.requestModel || '',
            additionalParams: redactAdditionalParams(args.additionalParams ?? []),
        },
    })
    plannedById.set(planned.id, planned)
}

function pushBinding(report: MigrationReport, target: BindingTarget, result: ProfileResolution | ModelBinding): void {
    if ('kind' in result && result.kind === 'plugin') {
        const binding: ModelBinding = { kind: 'pluginModel', id: result.pluginModelId }
        report.pluginBindings.push({ ...target, pluginModelId: result.pluginModelId, binding })
        return
    }
    if ('kind' in result && result.kind === 'manual') {
        const binding: ModelBinding = { kind: 'manualRequired', reason: result.reason, legacySource: target.sourcePath }
        addBinding(report, { ...target, binding })
        report.manualRequired.push({ sourcePath: target.sourcePath, reason: result.reason, legacySource: target.sourcePath })
        return
    }
    if ('kind' in result && result.kind === 'none') {
        return
    }
    addBinding(report, { ...target, binding: result as ModelBinding })
}

function addBinding(report: MigrationReport, binding: {
    scope: MigrationBindingScope
    ownerId?: string
    targetTask: ResolvedTask
    sourcePath: string
    binding: ModelBinding
}): void {
    if (binding.scope === 'global') {
        report.globalBindings.push(binding)
    } else if (binding.scope === 'chat') {
        report.chatBindings.push(binding)
    } else {
        report.botPresetBindings.push(binding)
    }
}

function bindingForLegacyModel(args: {
    model: string
    sourcePath: string
    plannedById: Map<string, PlannedModelPreset>
    db: ModelPresetMigrationInput
    botPreset?: LegacyBotPreset
}): ProfileResolution | ModelBinding {
    const { model, plannedById, db, botPreset, sourcePath } = args
    if (model.startsWith('pluginmodel:::')) {
        return { kind: 'plugin', pluginModelId: model }
    }
    if (model.startsWith('xcustom:::')) {
        const found = (db.customModels ?? []).find((customModel) => customModel.id === model)
        if (!found) {
            return { kind: 'manual', reason: `Custom model not found: ${model}` }
        }
        const planned = findPresetBySource(plannedById, `customModels.${found.id}`)
        if (!planned) {
            return { kind: 'manual', reason: `Custom model is not auto-migratable: ${model}` }
        }
        return { kind: 'modelPreset', id: planned.id }
    }
    if (model === 'reverse_proxy') {
        const source = botPreset ? botPresetReverseProxySource(sourcePath) : 'db.reverse_proxy'
        const planned = findPresetBySource(plannedById, source)
        if (planned) return { kind: 'modelPreset', id: planned.id }
        return { kind: 'manual', reason: 'Reverse proxy is not auto-migratable' }
    }

    const resolved = profileForLegacyModel(model, db, botPreset, sourcePath)
    if (resolved.kind !== 'profile') return resolved

    const planned = createPlannedPreset({
        sourceKind: 'legacy-model',
        sourcePath,
        profileId: resolved.profileId,
        name: `Migrated ${model}`,
        modelId: resolved.modelId || model,
        credentialPath: resolved.credentialPath,
        userValues: {
            modelId: resolved.modelId || model,
            format: botPreset?.customAPIFormat ?? db.customAPIFormat,
        },
    })
    plannedById.set(planned.id, planned)
    return { kind: 'modelPreset', id: planned.id }
}

function profileForLegacyModel(
    model: string,
    db: ModelPresetMigrationInput,
    botPreset: LegacyBotPreset | undefined,
    sourcePath: string,
): ProfileResolution {
    if (!model) return { kind: 'none' }
    if (model === 'openrouter' || model.startsWith('openrouter')) {
        return {
            kind: 'profile',
            profileId: 'openrouter:openai-compatible',
            modelId: botPreset?.openrouterRequestModel || db.openrouterRequestModel || model,
            credentialPath: credentialPathFor('openrouterKey', db, botPreset, sourcePath),
        }
    }
    if (model === 'nanogpt' || model.startsWith('nanogpt')) {
        return {
            kind: 'profile',
            profileId: 'nanogpt:openai-compatible',
            modelId: botPreset?.nanogptRequestModel || db.nanogptRequestModel || model,
            credentialPath: credentialPathFor('nanogptKey', db, botPreset, sourcePath),
        }
    }
    if (model === 'ollama' || model.startsWith('ollama')) {
        return { kind: 'profile', profileId: 'ollama:openai-compatible-local', modelId: model }
    }
    if (model.startsWith('deepseek')) {
        return { kind: 'profile', profileId: 'deepseek:openai-compatible', modelId: model }
    }
    if (model.startsWith('deepinfra_')) {
        return { kind: 'profile', profileId: 'deepinfra:openai-compatible', modelId: model }
    }
    if (model.startsWith('vercel:') || model.startsWith('vercel_')) {
        return { kind: 'profile', profileId: 'vercel:openai-compatible', modelId: model }
    }
    if (isOpenAIModelId(model)) {
        return { kind: 'profile', profileId: 'openai:standard', modelId: model, credentialPath: credentialPathFor('openAIKey', db, botPreset, sourcePath) }
    }
    if (model.startsWith('claude')) {
        return { kind: 'profile', profileId: 'anthropic:standard', modelId: model, credentialPath: credentialPathFor('claudeAPIKey', db, botPreset, sourcePath) }
    }
    if (model.startsWith('anthropic.claude')) {
        return { kind: 'manual', reason: `Native Bedrock Claude model requires manual migration: ${model}` }
    }
    if (model.startsWith('gemini')) {
        return { kind: 'profile', profileId: 'google:standard', modelId: model }
    }
    return { kind: 'manual', reason: `Unsupported legacy model: ${model}` }
}

function profileForFormat(format: number | undefined): string | undefined {
    switch (format) {
        case undefined:
        case LLMFormat.OpenAICompatible:
        case LLMFormat.OpenAIResponseAPI:
        case LLMFormat.NanoGPT:
        case LLMFormat.NanoGPTResponses:
        case LLMFormat.NanoGPTMessages:
        case LLMFormat.NanoGPTLegacy:
            return 'openai-compatible:custom'
        case LLMFormat.Ollama:
            return 'ollama:openai-compatible-local'
        case LLMFormat.Anthropic:
            return 'anthropic:standard'
        case LLMFormat.GoogleCloud:
        case LLMFormat.VertexAIGemini:
            return 'google:standard'
        default:
            return undefined
    }
}

function hasReverseProxyConfig(db: ModelPresetMigrationInput): boolean {
    return Boolean(
        db.aiModel === 'reverse_proxy' ||
        db.forceReplaceUrl ||
        db.customProxyRequestModel ||
        db.proxyKey ||
        (db.additionalParams?.length ?? 0) > 0,
    )
}

function hasPresetReverseProxyConfig(preset: LegacyBotPreset): boolean {
    return Boolean(
        preset.aiModel === 'reverse_proxy' ||
        preset.subModel === 'reverse_proxy' ||
        preset.forceReplaceUrl ||
        preset.proxyRequestModel ||
        preset.customProxyRequestModel ||
        preset.proxyKey,
    )
}

function botPresetReverseProxySource(sourcePath: string): string {
    const match = /^botPresets\.([^.]+)\./.exec(sourcePath)
    return match ? `botPresets.${match[1]}.reverse_proxy` : sourcePath.replace(/\.[^.]+$/, '.reverse_proxy')
}

function credentialPathFor(
    key: 'openAIKey' | 'openrouterKey' | 'nanogptKey' | 'claudeAPIKey',
    db: ModelPresetMigrationInput,
    botPreset: LegacyBotPreset | undefined,
    sourcePath: string,
): string | undefined {
    if (key === 'openAIKey' && botPreset?.openAIKey) {
        const match = /^botPresets\.([^.]+)\./.exec(sourcePath)
        return match ? `botPresets.${match[1]}.${key}` : `${sourcePath}.${key}`
    }
    return db[key] ? `db.${key}` : undefined
}

function addDeprecatedItems(report: MigrationReport, db: ModelPresetMigrationInput): void {
    if ((db.bias?.length ?? 0) > 0) {
        report.skippedBias.push({ sourcePath: 'db.bias', reason: 'Bias is not migrated to v4 ModelPreset or PromptPreset' })
    }
    for (const [index, preset] of (db.botPresets ?? []).entries()) {
        if ((preset.bias?.length ?? 0) > 0) {
            report.skippedBias.push({
                sourcePath: `botPresets.${preset.id || index}.bias`,
                reason: 'Bias is not migrated to v4 ModelPreset or PromptPreset',
            })
        }
        if ((preset.customFlags?.length ?? 0) > 0 || preset.enableCustomFlags) {
            report.preservedLegacyFields.push({
                sourcePath: `botPresets.${preset.id || index}.customFlags`,
                reason: 'Custom flags are preserved and only auto-mapped when profile schema supports them',
            })
        }
        if (preset.fallbackModels) {
            report.preservedLegacyFields.push({
                sourcePath: `botPresets.${preset.id || index}.fallbackModels`,
                reason: 'Fallback models are preserved for a later migration pass',
            })
        }
    }
    if ((db.customFlags?.length ?? 0) > 0 || db.enableCustomFlags) {
        report.preservedLegacyFields.push({
            sourcePath: 'db.customFlags',
            reason: 'Custom flags are preserved and only auto-mapped when profile schema supports them',
        })
    }
    if (db.fallbackModels) {
        report.preservedLegacyFields.push({
            sourcePath: 'db.fallbackModels',
            reason: 'Fallback models are preserved for a later migration pass',
        })
    }
    for (const path of ['modelTools', 'presetChain'] as const) {
        if (db[path] && ((Array.isArray(db[path]) && db[path].length > 0) || (!Array.isArray(db[path]) && db[path]))) {
            report.preservedLegacyFields.push({
                sourcePath: `db.${path}`,
                reason: 'Legacy field is preserved and not migrated by this dry-run analyzer',
            })
        }
    }
}

function createPlannedPreset(args: {
    sourceKind: string
    sourcePath: string
    profileId: string
    name: string
    modelId?: string
    endpointUrl?: string
    credentialPath?: string
    userValues: Record<string, unknown>
}): PlannedModelPreset {
    const canonicalNonSecretConfig = {
        profileId: args.profileId,
        modelId: args.modelId,
        endpointUrl: args.endpointUrl,
        userValues: args.userValues,
    }
    return {
        id: `migrated:${args.sourceKind}:${args.sourcePath}:${hashStable(canonicalNonSecretConfig)}`,
        name: args.name,
        sourceKind: args.sourceKind,
        sourcePath: args.sourcePath,
        profileId: args.profileId,
        modelId: args.modelId,
        endpointUrl: args.endpointUrl,
        credentialSource: args.credentialPath ? { kind: 'legacyKey', sourcePath: args.credentialPath } : undefined,
        userValues: cloneJsonLike(args.userValues) as Record<string, unknown>,
    }
}

function findPresetBySource(plannedById: Map<string, PlannedModelPreset>, sourcePath: string): PlannedModelPreset | undefined {
    return Array.from(plannedById.values()).find((preset) => preset.sourcePath === sourcePath)
}

function addManual(report: MigrationReport, sourcePath: string, reason: string, legacySource?: string): void {
    const item: ManualMigrationItem = { sourcePath, reason, legacySource }
    report.manualRequired.push(item)
}

function isOpenAIModelId(model: string): boolean {
    return model === 'o1' ||
        model === 'o3' ||
        model === 'o4' ||
        model.startsWith('gpt-') ||
        model.startsWith('o1-') ||
        model.startsWith('o3-') ||
        model.startsWith('o4-')
}

function redactAdditionalParams(params: [string, string][]): [string, string][] {
    return params.map(([key, value]) => [key, shouldRedactKey(key) || shouldRedactValue(value) ? '[redacted]' : value])
}

function redactFreeform(value: string): string {
    if (!value) return ''
    return shouldRedactValue(value) ? '[redacted]' : value
}

function shouldRedactKey(key: string): boolean {
    return /authorization|api[-_ ]?key|token|secret|bearer|credential/i.test(key)
}

function shouldRedactValue(value: string): boolean {
    return /bearer\s+\S+|sk-[A-Za-z0-9_-]+|api[-_ ]?key|token|secret/i.test(value)
}

function cloneArray<T>(value: T[]): T[] {
    return value.slice()
}

function cloneJsonLike(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(cloneJsonLike)
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[key] = cloneJsonLike(child)
    }
    return out
}

function hashStable(value: unknown): string {
    const input = stableStringify(value)
    let hash = 0x811c9dc5
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`
}
