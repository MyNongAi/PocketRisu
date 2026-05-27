import { describe, expect, test, vi } from 'vitest'
import { LLMFormat } from '../model/types'
import {
    analyzeModelPresetMigration,
    applyModelPresetMigration,
    type ModelPresetMigrationApplyTarget,
} from './migration'
import { bundledMigrationResolver } from './registry'
import type { MigrationReport } from './types'

describe('analyzeModelPresetMigration (plan v5: customModels-only)', () => {
    test('plans custom OpenAI-compatible models with apiKey credential path', () => {
        const report = analyzeModelPresetMigration({
            customModels: [{
                id: 'xcustom:::main',
                internalId: 'gpt-custom',
                url: 'https://example.test/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: 'sk-secret',
                name: 'Main Custom',
                params: '',
                flags: [],
            }],
        })
        expect(report.createdModelPresets).toHaveLength(1)
        const planned = report.createdModelPresets[0]
        expect(planned).toMatchObject({
            sourceKind: 'custom',
            sourcePath: 'customModels.xcustom:::main',
            profileId: 'openai-compatible:custom',
            modelId: 'gpt-custom',
            endpointUrl: 'https://example.test/v1/chat/completions',
            credentialSource: { kind: 'legacyKey', sourcePath: 'customModels.xcustom:::main.key' },
        })
        // Key value is never embedded in the planned id or userValues.
        expect(JSON.stringify(planned)).not.toContain('sk-secret')
    })

    test('routes no-credential custom OpenAI-compatible models to the custom-noauth profile', () => {
        const report = analyzeModelPresetMigration({
            customModels: [{
                id: 'xcustom:::local',
                internalId: 'llama-3',
                url: 'http://localhost:8000/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: '',
                name: 'Local',
            }],
        })
        expect(report.createdModelPresets[0].profileId).toBe('openai-compatible:custom-noauth')
        expect(report.createdModelPresets[0].credentialSource).toBeUndefined()
    })

    test('routes Anthropic / Google / Ollama formats to their bundled profiles', () => {
        const report = analyzeModelPresetMigration({
            customModels: [
                { id: 'a', format: LLMFormat.Anthropic, key: 'sk-ant' },
                { id: 'g', format: LLMFormat.GoogleCloud, key: 'goog' },
                { id: 'o', format: LLMFormat.Ollama, key: '' },
            ],
        })
        const profiles = report.createdModelPresets.map((p) => p.profileId)
        expect(profiles).toEqual([
            'anthropic:standard',
            'google:standard',
            'ollama:openai-compatible-local',
        ])
    })

    test('routes non-1:1 wire formats to manualRequired (no silent guess)', () => {
        // VertexAIGemini uses Bearer + aiplatform.googleapis.com, not AI Studio's
        // x-goog-api-key + generativelanguage.googleapis.com. OpenAIResponseAPI
        // and NanoGPT variants route through different request builders. Auto-
        // mapping them to a profile would produce a preset that talks to the
        // wrong endpoint or with the wrong auth header — v5 policy is to leave
        // them for the user to re-create via the new ModelPreset UI.
        const report = analyzeModelPresetMigration({
            customModels: [
                { id: 'v', format: LLMFormat.VertexAIGemini, key: 'vertex' },
                { id: 'r', format: LLMFormat.OpenAIResponseAPI, key: 'sk-resp' },
                { id: 'n1', format: LLMFormat.NanoGPTResponses, key: 'sk-r' },
                { id: 'n2', format: LLMFormat.NanoGPTMessages, key: 'sk-m' },
                { id: 'n3', format: LLMFormat.NanoGPTLegacy, key: 'sk-l' },
            ],
        })
        expect(report.createdModelPresets).toEqual([])
        const sourcePaths = report.manualRequired.map((m) => m.sourcePath)
        expect(sourcePaths).toEqual([
            'customModels.v',
            'customModels.r',
            'customModels.n1',
            'customModels.n2',
            'customModels.n3',
        ])
        // Secrets stay out of the manualRequired entries.
        const dryRunJson = JSON.stringify(report)
        for (const secret of ['vertex', 'sk-resp', 'sk-r', 'sk-m', 'sk-l']) {
            expect(dryRunJson).not.toContain(secret)
        }
    })

    test('falls back to db.google.accessToken when a Google custom model has no per-model key', () => {
        const report = analyzeModelPresetMigration({
            customModels: [{ id: 'g', format: LLMFormat.GoogleCloud, key: '' }],
            google: { accessToken: 'goog-fallback' },
        })
        expect(report.createdModelPresets[0].credentialSource).toEqual({
            kind: 'legacyKey',
            sourcePath: 'db.google.accessToken',
        })
    })

    test('per-model key wins over db.google.accessToken when both are present', () => {
        const report = analyzeModelPresetMigration({
            customModels: [{ id: 'g', format: LLMFormat.GoogleCloud, key: 'per-model' }],
            google: { accessToken: 'fallback' },
        })
        expect(report.createdModelPresets[0].credentialSource?.sourcePath).toBe('customModels.g.key')
    })

    test('reports manualRequired for custom models with unsupported format', () => {
        const report = analyzeModelPresetMigration({
            customModels: [{
                id: 'kobold-one',
                format: LLMFormat.Kobold,
                key: 'kobold-secret',
                name: 'Kobold',
            }],
        })
        expect(report.createdModelPresets).toEqual([])
        expect(report.manualRequired).toEqual([{
            sourcePath: 'customModels.kobold-one',
            reason: `Unsupported custom model format: ${LLMFormat.Kobold}`,
            legacySource: 'kobold-one',
        }])
    })

    test('redacts secret-like freeform params', () => {
        const report = analyzeModelPresetMigration({
            customModels: [{
                id: 'a',
                format: LLMFormat.OpenAICompatible,
                key: 'sk-test',
                params: 'authorization: Bearer sk-XXXXXX',
            }],
        })
        expect(report.createdModelPresets[0].userValues.params).toBe('[redacted]')
    })

    test('returns an empty report when there are no customModels', () => {
        const report = analyzeModelPresetMigration({})
        expect(report).toEqual({
            version: 1,
            createdModelPresets: [],
            manualRequired: [],
            warnings: [],
        })
    })

    test('handles customModels without an id by falling back to array index for source path lookup', () => {
        // Regression for corrupted/imported legacy data: a customModel that
        // lacks `id` should still get a deterministic source path AND have its
        // key lookup succeed during apply. analyze writes
        // `customModels.${id || index}`; readLegacyValueAtPath must mirror.
        const db: ModelPresetMigrationApplyTarget = {
            customModels: [{
                id: '',
                internalId: 'm-noid',
                url: 'https://x.test/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: 'sk-noid',
                name: 'No-Id',
            } as unknown as Parameters<typeof analyzeModelPresetMigration>[0]['customModels'][number]],
        }
        const report = analyzeModelPresetMigration(db)
        expect(report.createdModelPresets[0].sourcePath).toBe('customModels.0')
        applyModelPresetMigration(db, report)
        // Key landed in apiKeyPool — proves readLegacyValueAtPath resolved the
        // index-based source path back to the customModel.
        expect(Object.values(db.apiKeyPool ?? {}).some((e) => e.key === 'sk-noid')).toBe(true)
    })

    test('does not mutate input during dry-run', () => {
        const db: ModelPresetMigrationApplyTarget = {
            customModels: [{
                id: 'a',
                format: LLMFormat.OpenAICompatible,
                key: 'sk-test',
                params: '',
                flags: [],
            }],
        }
        const before = JSON.stringify(db)
        analyzeModelPresetMigration(db)
        expect(JSON.stringify(db)).toBe(before)
    })
})

describe('applyModelPresetMigration (plan v5)', () => {
    test('persists modelPresets + apiKeyPool entries without leaking secrets into the summary', () => {
        const db: ModelPresetMigrationApplyTarget = {
            customModels: [{
                id: 'xcustom:::main',
                internalId: 'gpt-custom',
                url: 'https://example.test/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: 'sk-secret',
                name: 'Main Custom',
            }],
        }
        const report = analyzeModelPresetMigration(db)
        applyModelPresetMigration(db, report)

        expect(db.modelPresets).toHaveLength(1)
        expect(db.modelPresets?.[0]).toMatchObject({
            migrationSource: { sourceKind: 'custom', sourcePath: 'customModels.xcustom:::main' },
            apiKeyRef: expect.any(String),
            profileSnapshot: {
                profileId: 'openai-compatible:custom',
                adapterKind: 'openai-compatible',
                modelId: 'gpt-custom',
            },
        })
        expect(Object.values(db.apiKeyPool ?? {})).toEqual([
            expect.objectContaining({
                provider: 'openai-compatible:custom',
                key: 'sk-secret',
            }),
        ])
        expect(db.modelPresetMigrationVersion).toBe(1)
        expect(JSON.stringify(db.modelPresetMigrationReport)).not.toContain('sk-secret')
        expect(JSON.stringify(report)).not.toContain('sk-secret')
    })

    test('reapplying migration upserts by source path instead of duplicating presets or keys', () => {
        const db: ModelPresetMigrationApplyTarget = {
            customModels: [{
                id: 'xcustom:::main',
                internalId: 'model-a',
                url: 'https://example.test/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: 'sk-secret-a',
                name: 'Main Custom',
            }],
        }
        const firstReport = analyzeModelPresetMigration(db)
        vi.useFakeTimers()
        vi.setSystemTime(1_000)
        applyModelPresetMigration(db, firstReport)
        const keyId = Object.keys(db.apiKeyPool ?? {})[0]
        if (keyId && db.apiKeyPool) {
            // Simulate a user renaming the migrated key — reapply must preserve
            // user-edited metadata (name, createdAt).
            db.apiKeyPool[keyId].name = 'User Named Key'
            db.apiKeyPool[keyId].createdAt = 123
        }

        vi.setSystemTime(2_000)
        const secondReport = analyzeModelPresetMigration(db)
        applyModelPresetMigration(db, secondReport)
        vi.useRealTimers()

        expect(db.modelPresets).toHaveLength(1)
        expect(Object.keys(db.apiKeyPool ?? {})).toHaveLength(1)
        const kept = db.apiKeyPool?.[Object.keys(db.apiKeyPool)[0]]
        expect(kept?.name).toBe('User Named Key')
        expect(kept?.createdAt).toBe(123)
        expect(kept?.updatedAt).toBe(2_000)
    })

    test('applies manualRequired report without creating presets for unsupported formats', () => {
        const db: ModelPresetMigrationApplyTarget = {
            customModels: [{
                id: 'kobold',
                format: LLMFormat.Kobold,
                key: 'k',
            }],
        }
        const report = analyzeModelPresetMigration(db)
        applyModelPresetMigration(db, report)
        expect(db.modelPresets).toEqual([])
        expect(db.apiKeyPool).toEqual({})
        expect(db.modelPresetMigrationReport?.manualRequiredCount).toBe(1)
        expect(db.modelPresetMigrationReport?.createdModelPresetCount).toBe(0)
    })

    test('uses bundled registry snapshot when resolver is provided', () => {
        const db: ModelPresetMigrationApplyTarget = {
            customModels: [{
                id: 'x',
                format: LLMFormat.OpenAICompatible,
                key: 'sk',
                url: 'https://my-proxy.test/v1/chat/completions',
                internalId: 'my-model',
                name: 'My',
            }],
        }
        const report = analyzeModelPresetMigration(db)
        applyModelPresetMigration(db, report, bundledMigrationResolver())

        const snapshot = db.modelPresets?.[0]?.profileSnapshot
        expect(snapshot?.profileId).toBe('openai-compatible:custom')
        expect(snapshot?.adapterKind).toBe('openai-compatible')
        expect(snapshot?.auth.kind).toBe('bearer')
        // endpointUrl override + modelId are preserved via userValues even when
        // the snapshot itself ships with an empty endpoint.url.
        expect(db.modelPresets?.[0]?.userValues.endpointUrl).toBe('https://my-proxy.test/v1/chat/completions')
        expect(db.modelPresets?.[0]?.userValues.modelId).toBe('my-model')
        expect(db.modelPresets?.[0]?.sourceProfile).toMatchObject({
            registryId: 'bundled',
            profileId: 'openai-compatible:custom',
            profileVersion: 1,
        })
        expect(db.modelPresets?.[0]?.sourceProfile?.fetchedAt).toEqual(expect.any(Number))
    })

    test('clears sourceProfile when reapplied without a resolver', () => {
        const db: ModelPresetMigrationApplyTarget = {
            customModels: [{ id: 'x', format: LLMFormat.OpenAICompatible, key: 'sk' }],
        }
        applyModelPresetMigration(db, analyzeModelPresetMigration(db), bundledMigrationResolver())
        expect(db.modelPresets?.[0]?.sourceProfile?.registryId).toBe('bundled')

        applyModelPresetMigration(db, analyzeModelPresetMigration(db))
        expect(db.modelPresets?.[0]?.sourceProfile).toBeUndefined()
        // Fallback snapshot has empty schema and no source pointer.
        expect(db.modelPresets?.[0]?.profileSnapshot.schema).toEqual([])
    })

    test('throws on unsupported report version', () => {
        const db: ModelPresetMigrationApplyTarget = {}
        const report = { version: 99 } as unknown as MigrationReport
        expect(() => applyModelPresetMigration(db, report)).toThrow(/Unsupported.*version/)
    })
})
