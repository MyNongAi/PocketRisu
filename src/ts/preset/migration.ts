import { LLMFormat } from '../model/types'
import type {
    ApiKeyPoolEntry,
    MigrationReport,
    ModelPreset,
    ModelPresetMigrationSummary,
    ModelPresetSourceProfile,
    PlannedModelPreset,
    ResolvedModelProfileSnapshot,
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

/**
 * Migration input contract (plan v5).
 *
 * v4 attempted to auto-infer presets from the entire legacy DB surface
 * (provider keys, reverse-proxy fields, native `aiModel` strings, botPreset
 * overrides, …). v5 narrows to `customModels[]` only — the one legacy shape
 * that maps 1:1 to a v4 ModelPreset. Everything else (18 provider API keys,
 * reverse-proxy fields, prompt/parameter settings, fallbacks, bias) stays in
 * the legacy DB untouched and is surfaced through the "Legacy Info" UI for
 * the user to reference when building new ModelPresets manually.
 *
 * The `google.accessToken` fallback is retained because the legacy Google
 * dispatch path itself falls back to it when a per-customModel key is empty
 * (see process/request/google.ts: `arg.key || db.google.accessToken`).
 */
export type ModelPresetMigrationInput = {
    customModels?: LegacyCustomModel[]
    google?: { accessToken?: string }
}

export type ModelPresetMigrationApplyTarget = ModelPresetMigrationInput & {
    modelPresets?: ModelPreset[]
    apiKeyPool?: Record<string, ApiKeyPoolEntry>
    modelPresetMigrationVersion?: number
    modelPresetMigrationAppliedAt?: number
    modelPresetMigrationReport?: ModelPresetMigrationSummary
}

export interface MigrationSnapshotResult {
    snapshot: ResolvedModelProfileSnapshot
    sourceProfile?: ModelPresetSourceProfile
}

export type MigrationSnapshotResolver = (
    planned: PlannedModelPreset,
) => ResolvedModelProfileSnapshot | MigrationSnapshotResult | undefined

function normalizeSnapshotResult(
    raw: ResolvedModelProfileSnapshot | MigrationSnapshotResult | undefined,
): MigrationSnapshotResult | undefined {
    if (!raw) return undefined
    if ((raw as MigrationSnapshotResult).snapshot) return raw as MigrationSnapshotResult
    return { snapshot: raw as ResolvedModelProfileSnapshot }
}

export function analyzeModelPresetMigration(db: ModelPresetMigrationInput): MigrationReport {
    const report: MigrationReport = {
        version: 1,
        createdModelPresets: [],
        manualRequired: [],
        warnings: [],
    }

    for (const [index, customModel] of (db.customModels ?? []).entries()) {
        const sourcePath = `customModels.${customModel.id || index}`
        const baseProfileId = profileForFormat(customModel.format)
        if (!baseProfileId) {
            report.manualRequired.push({
                sourcePath,
                reason: `Unsupported custom model format: ${customModel.format}`,
                legacySource: customModel.id,
            })
            continue
        }
        const profileId = pickOpenAiCompatibleProfile(baseProfileId, isNonEmptyString(customModel.key))
        // Legacy Google call path falls back to db.google.accessToken when the
        // per-model key is empty (see process/request/google.ts: `arg.key ||
        // db.google.accessToken`). Mirror that fallback during migration so a
        // Google custom model with empty key + valid top-level Google key still
        // ends up with a resolvable apiKeyRef. Per-model key always wins.
        const credentialPath = isNonEmptyString(customModel.key)
            ? `${sourcePath}.key`
            : (profileId === 'google:standard' && isNonEmptyString(db.google?.accessToken)
                ? 'db.google.accessToken'
                : undefined)
        report.createdModelPresets.push(createPlannedPreset({
            sourceKind: 'custom',
            sourcePath,
            profileId,
            name: customModel.name || customModel.id || `Custom Model ${index + 1}`,
            endpointUrl: customModel.url || '',
            modelId: customModel.internalId || customModel.id,
            credentialPath,
            userValues: {
                endpointUrl: customModel.url || '',
                modelId: customModel.internalId || customModel.id,
                params: redactFreeform(customModel.params || ''),
                flags: (customModel.flags ?? []).slice(),
            },
        }))
    }

    return report
}

export function applyModelPresetMigration(
    db: ModelPresetMigrationApplyTarget,
    report: MigrationReport,
    resolveSnapshot?: MigrationSnapshotResolver,
): void {
    if (report.version !== 1) {
        throw new Error(`Unsupported ModelPreset migration report version: ${report.version}`)
    }

    const appliedAt = Date.now()
    db.modelPresets = Array.isArray(db.modelPresets) ? db.modelPresets : []
    db.apiKeyPool = db.apiKeyPool && typeof db.apiKeyPool === 'object' && !Array.isArray(db.apiKeyPool)
        ? db.apiKeyPool
        : {}

    for (const planned of report.createdModelPresets) {
        upsertApiKeyPoolEntry(db, planned, appliedAt)
        upsertModelPreset(db, planned, appliedAt, resolveSnapshot)
    }

    db.modelPresetMigrationVersion = report.version
    db.modelPresetMigrationAppliedAt = appliedAt
    db.modelPresetMigrationReport = summarizeMigrationReport(report, appliedAt)
}

function upsertApiKeyPoolEntry(
    db: ModelPresetMigrationApplyTarget,
    planned: PlannedModelPreset,
    now: number,
): void {
    const credentialPath = planned.credentialSource?.sourcePath
    if (!credentialPath || !db.apiKeyPool) return

    const key = readLegacyStringAtPath(db, credentialPath)
    if (!key) return

    const id = apiKeyPoolIdForSourcePath(credentialPath)
    const existing = db.apiKeyPool[id]
    db.apiKeyPool[id] = {
        id,
        name: existing?.name || `Migrated ${credentialPath}`,
        provider: existing?.provider || planned.profileId,
        key,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    }
}

function upsertModelPreset(
    db: ModelPresetMigrationApplyTarget,
    planned: PlannedModelPreset,
    now: number,
    resolveSnapshot?: MigrationSnapshotResolver,
): void {
    if (!db.modelPresets) return

    const existingIndex = db.modelPresets.findIndex((preset) =>
        preset.migrationSource?.sourcePath === planned.sourcePath ||
        preset.id === planned.id
    )
    const existing = existingIndex >= 0 ? db.modelPresets[existingIndex] : undefined
    const apiKeyRef = apiKeyPoolRefForPlanned(db, planned)
    const resolved = normalizeSnapshotResult(resolveSnapshot?.(planned))
    const preset: ModelPreset = {
        id: planned.id,
        name: existing?.name || planned.name,
        notes: existing?.notes,
        // sourceProfile must match the snapshot we are about to write. Falling
        // back to existing metadata when the new snapshot came from a different
        // path (or from the fallback) would leave stale registry pointers and
        // break profile-update detection later.
        sourceProfile: resolved?.sourceProfile,
        migrationSource: {
            sourceKind: planned.sourceKind,
            sourcePath: planned.sourcePath,
            configHash: configHashFromPlannedId(planned.id),
        },
        profileSnapshot: resolved?.snapshot || createFallbackMigrationSnapshot(planned),
        userValues: cloneJsonLike(planned.userValues) as Record<string, unknown>,
        orphanValues: existing?.orphanValues,
        apiKeyRef,
        inlineCredential: existing?.inlineCredential,
        fallbackModelPresetIds: existing?.fallbackModelPresetIds,
        pinned: existing?.pinned,
        order: existing?.order,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    }

    if (existingIndex >= 0) {
        db.modelPresets[existingIndex] = preset
    } else {
        db.modelPresets.push(preset)
    }
}

function summarizeMigrationReport(report: MigrationReport, appliedAt: number): ModelPresetMigrationSummary {
    return {
        version: report.version,
        appliedAt,
        createdModelPresetCount: report.createdModelPresets.length,
        manualRequiredCount: report.manualRequired.length,
        warnings: report.warnings.slice(),
    }
}

function createFallbackMigrationSnapshot(planned: PlannedModelPreset): ResolvedModelProfileSnapshot {
    return {
        profileId: planned.profileId,
        profileVersion: 1,
        providerBaseId: providerBaseIdForProfile(planned.profileId),
        // Migrations applied without a registry resolver also skip writing
        // `sourceProfile`, so this value never reaches `getProfileUpdateAvailability`
        // — it returns 'no-source' first. Re-running migration with the
        // bundled resolver fills the real snapshot (and sourceProfile).
        providerBaseVersion: 1,
        adapterKind: adapterKindForProfile(planned.profileId),
        auth: { kind: authKindForProfile(planned.profileId), fields: planned.credentialSource ? ['apiKey'] : undefined },
        endpoint: { kind: 'static', url: planned.endpointUrl ?? '' },
        modelId: planned.modelId || planned.profileId,
        schema: [],
        uiSchema: { groups: [], fields: [] },
        defaults: {},
        capabilities: ['streaming'],
    }
}

function providerBaseIdForProfile(profileId: string): string {
    if (profileId.startsWith('openai-compatible:')) return 'openai-compatible'
    return profileId.split(':')[0] || profileId
}

function adapterKindForProfile(profileId: string): ResolvedModelProfileSnapshot['adapterKind'] {
    if (profileId.startsWith('anthropic:')) return 'anthropic-messages'
    if (profileId.startsWith('google:')) return 'google-gemini'
    return 'openai-compatible'
}

function authKindForProfile(profileId: string): ResolvedModelProfileSnapshot['auth']['kind'] {
    if (profileId.startsWith('ollama:')) return 'none'
    if (profileId.startsWith('anthropic:')) return 'x-api-key'
    if (profileId.startsWith('google:')) return 'x-goog-api-key'
    if (profileId === 'openai-compatible:custom-noauth') return 'none'
    return 'bearer'
}

function readLegacyStringAtPath(db: ModelPresetMigrationApplyTarget, sourcePath: string): string | undefined {
    const value = readLegacyValueAtPath(db, sourcePath)
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readLegacyValueAtPath(db: ModelPresetMigrationApplyTarget, sourcePath: string): unknown {
    if (sourcePath.startsWith('db.')) {
        return readPathSegments(db as Record<string, unknown>, sourcePath.slice(3).split('.'))
    }
    if (sourcePath.startsWith('customModels.')) {
        const [, identifier, ...rest] = sourcePath.split('.')
        // analyze step writes `customModels.${customModel.id || index}` so a
        // legacy import without ids still gets a deterministic source path.
        // Read-back must mirror that fallback: try id first, then array index.
        const list = db.customModels ?? []
        let customModel = list.find((model) => model.id === identifier)
        if (!customModel && /^\d+$/.test(identifier)) {
            const index = Number(identifier)
            if (Number.isInteger(index) && index >= 0 && index < list.length) {
                customModel = list[index]
            }
        }
        return readPathSegments(customModel as Record<string, unknown> | undefined, rest)
    }
    return undefined
}

function readPathSegments(source: Record<string, unknown> | undefined, segments: string[]): unknown {
    let value: unknown = source
    for (const segment of segments) {
        if (value === null || typeof value !== 'object') return undefined
        value = (value as Record<string, unknown>)[segment]
    }
    return value
}

function apiKeyPoolIdForSourcePath(sourcePath: string): string {
    return `migrated-key:${hashStable(sourcePath)}`
}

function apiKeyPoolRefForPlanned(
    db: ModelPresetMigrationApplyTarget,
    planned: PlannedModelPreset,
): string | undefined {
    const sourcePath = planned.credentialSource?.sourcePath
    if (!sourcePath || !db.apiKeyPool) return undefined
    const id = apiKeyPoolIdForSourcePath(sourcePath)
    return db.apiKeyPool[id] ? id : undefined
}

function configHashFromPlannedId(id: string): string {
    const index = id.lastIndexOf(':')
    return index >= 0 ? id.slice(index + 1) : ''
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

// v5 policy: only formats whose wire shape is genuinely 1:1 with a bundled
// profile get auto-migrated. Anything else (OpenAI Responses API, NanoGPT
// non-default variants, Vertex AI Gemini's Bearer+aiplatform.googleapis.com
// transport, …) gets a `manualRequired` entry and is left for the user to
// re-create via the new ModelPreset UI — guessing on those would produce a
// preset that silently talks to the wrong endpoint or with the wrong auth
// header.
function profileForFormat(format: number | undefined): string | undefined {
    switch (format) {
        case undefined:
        case LLMFormat.OpenAICompatible:
        case LLMFormat.NanoGPT:
            // NanoGPT (id 20) is the OpenAI-compatible variant; the other
            // NanoGPT* enum values (Responses/Messages/Legacy) route through
            // different request builders in process/request/request.ts and
            // must NOT be auto-migrated.
            return 'openai-compatible:custom'
        case LLMFormat.Ollama:
            return 'ollama:openai-compatible-local'
        case LLMFormat.Anthropic:
            return 'anthropic:standard'
        case LLMFormat.GoogleCloud:
            // Google AI Studio (x-goog-api-key + generativelanguage.googleapis.com).
            // VertexAIGemini deliberately omitted: it uses Bearer + a different
            // host and requires the SA-auth Vertex profile (vertex-openai:standard,
            // §14-5), which the user must select via UI.
            return 'google:standard'
        default:
            return undefined
    }
}

// Custom OpenAI-compatible endpoints (self-hosted vLLM, LiteLLM, local Ollama
// OpenAI mode, etc.) often run without authentication. The bundled registry
// expresses this as a separate `openai-compatible:custom-noauth` profile
// (auth.kind = 'none'); migration picks it whenever the legacy source has no
// credential. Other base providers always carry a credential by contract.
function pickOpenAiCompatibleProfile(baseProfileId: string, hasCredential: boolean): string {
    if (baseProfileId === 'openai-compatible:custom' && !hasCredential) {
        return 'openai-compatible:custom-noauth'
    }
    return baseProfileId
}

function redactFreeform(value: string): string {
    if (!value) return ''
    return shouldRedactValue(value) ? '[redacted]' : value
}

function shouldRedactValue(value: string): boolean {
    return /bearer\s+\S+|sk-[A-Za-z0-9_-]+|api[-_ ]?key|token|secret/i.test(value)
}

// Truthy checks on legacy DB fields (`db.proxyKey ? ... : ''`) would silently
// accept non-string truthy values (e.g. a number left by a corrupted import)
// and produce phantom credentialPath entries in the dry-run report, even
// though the apply phase later filters them out via `readLegacyStringAtPath`.
// Strict checking at analyze time keeps report/summary honest.
function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
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
