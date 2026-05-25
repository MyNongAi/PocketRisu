/**
 * Migrated preset → buildPreparedRequest end-to-end coverage (plan §14-11).
 *
 * Proves that each migrated ModelPreset, once persisted by `applyMigration`
 * with the bundled registry resolver, produces a syntactically valid wire
 * request when handed back to the adapter layer via `buildPreparedRequest`.
 *
 * Catches the class of regression where snapshot fields routed by `mapsTo`
 * mismatch what the adapter expects (URL, auth header, body shape), or where
 * a new profile/wire variant ships without a corresponding adapter branch.
 *
 * The Vertex/SA path is excluded here because it requires the async
 * resolveAdapterCredential step (covered in vertexIntegration.test.ts and
 * openaiCompatibleVertex.test.ts).
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

describe('migrated preset → buildPreparedRequest wire shape', () => {
    test('openai:standard preset → bearer + OpenAI URL + body.model from legacy aiModel', () => {
        const presets = migrate({
            aiModel: 'gpt-4o',
            openAIKey: 'sk-openai-test',
        })
        const preset = presetByProfileId(presets, 'openai:standard')
        const prepared = buildPreparedRequest({
            preset,
            credential: { apiKey: 'sk-openai-test' },
        })
        expect(prepared.url).toBe('https://api.openai.com/v1/chat/completions')
        expect(prepared.method).toBe('POST')
        expect(prepared.headers.Authorization).toBe('Bearer sk-openai-test')
        expect(prepared.headers['Content-Type']).toBe('application/json')
        expect(prepared.body.model).toBe('gpt-4o')
    })

    test('anthropic:standard preset → x-api-key + anthropic-version + body.model', () => {
        const presets = migrate({
            aiModel: 'claude-sonnet-4-5',
            claudeAPIKey: 'sk-ant-test',
        })
        const preset = presetByProfileId(presets, 'anthropic:standard')
        const prepared = buildPreparedRequest({
            preset,
            credential: { apiKey: 'sk-ant-test' },
        })
        expect(prepared.url).toBe('https://api.anthropic.com/v1/messages')
        expect(prepared.headers['x-api-key']).toBe('sk-ant-test')
        expect(prepared.headers['anthropic-version']).toBe('2023-06-01')
        // Bearer must NOT be set for x-api-key auth (wire invariant).
        expect(prepared.headers.Authorization).toBeUndefined()
        expect(prepared.body.model).toBe('claude-sonnet-4-5')
    })

    test('google:standard preset → x-goog-api-key + body.model', () => {
        // Migration analyzer doesn't currently consume a top-level Google API
        // key — google presets land without an apiKeyRef. The adapter layer
        // can still accept a credential at request time, so we feed one
        // directly to exercise the wire shape.
        const presets = migrate({ aiModel: 'gemini-2.5-pro' })
        const preset = presetByProfileId(presets, 'google:standard')
        const prepared = buildPreparedRequest({
            preset,
            credential: { apiKey: 'goog-test' },
        })
        expect(prepared.headers['x-goog-api-key']).toBe('goog-test')
        // body.model resolved from legacy aiModel via migration.
        expect(prepared.body.model).toBe('gemini-2.5-pro')
        // Google base URL is not the OpenAI URL.
        expect(prepared.url).not.toContain('openai.com')
    })

    test('openai-compatible:custom preset → custom URL + bearer + custom model id', () => {
        const presets = migrate({
            customModels: [{
                id: 'xcustom:::main',
                internalId: 'my-local-model',
                url: 'https://my-proxy.test/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: 'sk-custom-test',
                name: 'Main Custom',
                params: '',
                flags: [],
            }],
            aiModel: 'xcustom:::main',
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

    test('openai-compatible:custom-noauth preset → custom URL + no Authorization header', () => {
        const presets = migrate({
            customModels: [{
                id: 'xcustom:::local',
                internalId: 'llama-3',
                url: 'http://localhost:8000/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: '',
                name: 'Local',
                params: '',
                flags: [],
            }],
            aiModel: 'xcustom:::local',
        })
        const preset = presetByProfileId(presets, 'openai-compatible:custom-noauth')
        const prepared = buildPreparedRequest({ preset, credential: undefined })
        expect(prepared.url).toBe('http://localhost:8000/v1/chat/completions')
        // No-auth profile must not emit any Authorization-like header.
        expect(prepared.headers.Authorization).toBeUndefined()
        expect(prepared.headers['x-api-key']).toBeUndefined()
        expect(prepared.body.model).toBe('llama-3')
    })

    test('reverse proxy with key → openai-compatible:custom preset talks to the proxy URL', () => {
        const presets = migrate({
            forceReplaceUrl: 'https://reverse.test/v1/chat/completions',
            proxyKey: 'sk-reverse',
            customAPIFormat: LLMFormat.OpenAICompatible,
            customProxyRequestModel: 'gpt-4o-proxy',
            aiModel: 'reverse_proxy',
        })
        const preset = presetByProfileId(presets, 'openai-compatible:custom')
        const prepared = buildPreparedRequest({
            preset,
            credential: { apiKey: 'sk-reverse' },
        })
        expect(prepared.url).toBe('https://reverse.test/v1/chat/completions')
        expect(prepared.headers.Authorization).toBe('Bearer sk-reverse')
        expect(prepared.body.model).toBe('gpt-4o-proxy')
    })

    test('every migrated non-vertex preset builds a request without throwing', () => {
        // Regression net for any future bundled profile addition: a single
        // migration that touches several legacy sources should not produce a
        // preset whose snapshot the shared request builder rejects.
        const presets = migrate({
            customModels: [{
                id: 'xcustom:::a',
                internalId: 'm-a',
                url: 'https://a.test/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: 'k-a',
                name: 'A',
                params: '',
                flags: [],
            }],
            aiModel: 'gpt-4o',
            subModel: 'claude-sonnet-4-5',
            seperateModels: { memory: 'gemini-2.5-pro' },
            seperateModelsForAxModels: true,
            openAIKey: 'sk-openai',
            claudeAPIKey: 'sk-ant',
        })

        // Pick a credential that satisfies the loosest profile (bearer).
        for (const preset of presets) {
            // Skip any profile whose auth needs the async resolveAdapterCredential
            // step (SA JSON → access token exchange). The wire shape for those
            // is covered by [vertexIntegration.test.ts](./adapter/vertexIntegration.test.ts)
            // and [openaiCompatibleVertex.test.ts](./adapter/openaiCompatibleVertex.test.ts).
            // Skipping on auth.kind (not endpoint.kind) keeps this guard correct
            // if a future profile pairs SA auth with a non-vertex endpoint.
            if (preset.profileSnapshot.auth.kind === 'google-service-account') continue
            expect(() =>
                buildPreparedRequest({ preset, credential: { apiKey: 'placeholder' } }),
            ).not.toThrow()
        }
    })
})
