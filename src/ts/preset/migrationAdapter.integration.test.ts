/**
 * Migrated preset → buildPreparedRequest end-to-end coverage (plan v5).
 *
 * v5 narrows migration to `customModels[]`-only, so the only profile families
 * that can arrive via the migration pipeline are:
 *  - openai-compatible:custom         (custom OpenAI-compatible with key)
 *  - openai-compatible:custom-noauth  (self-hosted / no key)
 *  - anthropic:sonnet-adaptive         (LLMFormat.Anthropic custom model)
 *  - google:gemini-3                   (LLMFormat.GoogleCloud — AI Studio only)
 *  - ollama:openai-compatible-local   (LLMFormat.Ollama)
 *
 * LLMFormat.VertexAIGemini deliberately does NOT reach `google:gemini-3` via
 * migration; Vertex uses Bearer + aiplatform.googleapis.com and lands in
 * `manualRequired` (see migration.test.ts "routes non-1:1 wire formats to
 * manualRequired"). The Vertex SA flow itself is covered by
 * [vertexIntegration.test.ts](./adapter/vertexIntegration.test.ts) +
 * [openaiCompatibleVertex.test.ts](./adapter/openaiCompatibleVertex.test.ts).
 *
 * Native provider migration (db.openAIKey → openai:gpt-55 etc.) was dropped
 * in v5 — that surface lives in the "Legacy Info" UI now.
 */
import { describe, expect, test } from 'vitest'
import { LLMFormat } from '../model/types'
import { buildPreparedRequest } from './adapter/buildRequest'
import {
    analyzeModelPresetMigration,
    applyModelPresetMigration,
    type ModelPresetMigrationApplyTarget,
} from './migration'
import { bundledMigrationResolver } from './registry'
import type { ModelPreset } from './types'

function migrate(db: ModelPresetMigrationApplyTarget): ModelPreset[] {
    const report = analyzeModelPresetMigration(db)
    applyModelPresetMigration(db, report, bundledMigrationResolver())
    return db.modelPresets ?? []
}

function presetByProfileId(presets: ModelPreset[], profileId: string): ModelPreset {
    const found = presets.find((p) => p.profileSnapshot.profileId === profileId)
    if (!found) throw new Error(`no migrated preset for ${profileId}`)
    return found
}

describe('migrated preset → buildPreparedRequest wire shape (v5)', () => {
    test('openai-compatible:custom (with key) → custom URL + bearer + custom model id', () => {
        const presets = migrate({
            customModels: [{
                id: 'xcustom:::main',
                internalId: 'my-local-model',
                url: 'https://my-proxy.test/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: 'sk-custom-test',
                name: 'Main Custom',
            }],
        })
        const preset = presetByProfileId(presets, 'openai-compatible:custom')
        const prepared = buildPreparedRequest({
            preset,
            credential: { apiKey: 'sk-custom-test' },
        })
        expect(prepared.url).toBe('https://my-proxy.test/v1/chat/completions')
        expect(prepared.headers.Authorization).toBe('Bearer sk-custom-test')
        expect(prepared.body.model).toBe('my-local-model')
    })

    test('openai-compatible:custom-noauth → custom URL + no Authorization header', () => {
        const presets = migrate({
            customModels: [{
                id: 'xcustom:::local',
                internalId: 'llama-3',
                url: 'http://localhost:8000/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: '',
                name: 'Local',
            }],
        })
        const preset = presetByProfileId(presets, 'openai-compatible:custom-noauth')
        const prepared = buildPreparedRequest({ preset, credential: undefined })
        expect(prepared.url).toBe('http://localhost:8000/v1/chat/completions')
        // No-auth profile must not emit any Authorization-like header.
        expect(prepared.headers.Authorization).toBeUndefined()
        expect(prepared.headers['x-api-key']).toBeUndefined()
        expect(prepared.body.model).toBe('llama-3')
    })

    test('google:gemini-3 (LLMFormat.GoogleCloud customModel) → x-goog-api-key + AI Studio URL', () => {
        // Pinning the wire shape here makes sure that if migration ever silently
        // routes VertexAIGemini back into this profile (it must NOT — see
        // migration.test.ts "routes non-1:1 wire formats to manualRequired"),
        // the wrong endpoint/auth would surface immediately as a request shape
        // regression.
        const presets = migrate({
            customModels: [{
                id: 'xcustom:::gemini',
                internalId: 'gemini-2.5-pro',
                format: LLMFormat.GoogleCloud,
                key: 'goog-test',
                name: 'Gemini',
            }],
        })
        const preset = presetByProfileId(presets, 'google:gemini-3')
        const prepared = buildPreparedRequest({
            preset,
            credential: { apiKey: 'goog-test' },
        })
        expect(prepared.headers['x-goog-api-key']).toBe('goog-test')
        // No Bearer auth (that would indicate accidental Vertex routing).
        expect(prepared.headers.Authorization).toBeUndefined()
        // AI Studio host, not Vertex's *-aiplatform.googleapis.com.
        expect(prepared.url).not.toContain('aiplatform.googleapis.com')
        expect(prepared.url).not.toContain('openai.com')
    })

    test('anthropic:sonnet-adaptive (LLMFormat.Anthropic customModel) → x-api-key + version header', () => {
        const presets = migrate({
            customModels: [{
                id: 'xcustom:::claude',
                internalId: 'claude-sonnet-4-5',
                format: LLMFormat.Anthropic,
                key: 'sk-ant-test',
                name: 'Claude',
            }],
        })
        const preset = presetByProfileId(presets, 'anthropic:sonnet-adaptive')
        const prepared = buildPreparedRequest({
            preset,
            credential: { apiKey: 'sk-ant-test' },
        })
        expect(prepared.headers['x-api-key']).toBe('sk-ant-test')
        expect(prepared.headers['anthropic-version']).toBe('2023-06-01')
        expect(prepared.headers.Authorization).toBeUndefined()
        expect(prepared.body.model).toBe('claude-sonnet-4-5')
    })

    test('every migrated non-SA preset builds a request without throwing (sweep)', () => {
        // Regression net: a single migrate of several customModels should
        // never produce a preset whose snapshot the shared request builder
        // rejects. SA-auth profiles need the async resolveAdapterCredential
        // path and have their own integration tests.
        const presets = migrate({
            customModels: [
                { id: 'a', format: LLMFormat.OpenAICompatible, key: 'k', url: 'https://a.test/v1/chat/completions', internalId: 'm-a' },
                { id: 'b', format: LLMFormat.OpenAICompatible, key: '', url: 'http://localhost:9/v1/chat/completions', internalId: 'm-b' },
                { id: 'c', format: LLMFormat.Anthropic, key: 'k-c', internalId: 'claude-x' },
                { id: 'd', format: LLMFormat.GoogleCloud, key: 'k-d', internalId: 'gemini-x' },
                { id: 'e', format: LLMFormat.Ollama, key: '', url: 'http://localhost:11434/v1/chat/completions', internalId: 'm-e' },
            ],
        })
        for (const preset of presets) {
            if (preset.profileSnapshot.auth.kind === 'google-service-account') continue
            expect(() =>
                buildPreparedRequest({ preset, credential: { apiKey: 'placeholder' } }),
            ).not.toThrow()
        }
    })
})
