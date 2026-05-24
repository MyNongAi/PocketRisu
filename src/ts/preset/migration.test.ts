import { describe, expect, test } from 'vitest'
import { LLMFormat } from '../model/types'
import { analyzeModelPresetMigration } from './migration'

describe('analyzeModelPresetMigration', () => {
    test('plans custom OpenAI-compatible models without leaking key material into ids', () => {
        const report = analyzeModelPresetMigration({
            customModels: [{
                id: 'xcustom:::main',
                internalId: 'gpt-custom',
                url: 'https://example.test/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: 'sk-secret',
                name: 'Main Custom',
                params: 'temperature=0.7',
                flags: [8],
            }],
            aiModel: 'xcustom:::main',
        })

        expect(report.createdModelPresets).toHaveLength(1)
        expect(report.createdModelPresets[0]).toMatchObject({
            sourceKind: 'custom',
            sourcePath: 'customModels.xcustom:::main',
            profileId: 'openai-compatible:custom',
            modelId: 'gpt-custom',
            credentialSource: {
                kind: 'legacyKey',
                sourcePath: 'customModels.xcustom:::main.key',
            },
        })
        expect(JSON.stringify(report.createdModelPresets)).not.toContain('sk-secret')
        expect(report.createdModelPresets[0].id).not.toContain('sk-secret')
        expect(report.globalBindings).toContainEqual({
            scope: 'global',
            targetTask: 'model',
            sourcePath: 'db.aiModel',
            binding: { kind: 'modelPreset', id: report.createdModelPresets[0].id },
        })
    })

    test('plans reverse proxy as custom OpenAI-compatible profile', () => {
        const report = analyzeModelPresetMigration({
            aiModel: 'reverse_proxy',
            forceReplaceUrl: 'https://proxy.test/v1/chat/completions',
            customProxyRequestModel: 'proxy-model',
            proxyKey: 'proxy-secret',
            customAPIFormat: LLMFormat.OpenAICompatible,
            additionalParams: [['x-provider', 'abc']],
        })

        expect(report.createdModelPresets).toHaveLength(1)
        expect(report.createdModelPresets[0]).toMatchObject({
            sourceKind: 'reverse-proxy',
            sourcePath: 'db.reverse_proxy',
            profileId: 'openai-compatible:custom',
            modelId: 'proxy-model',
            endpointUrl: 'https://proxy.test/v1/chat/completions',
            credentialSource: {
                kind: 'legacyKey',
                sourcePath: 'db.proxyKey',
            },
        })
        expect(JSON.stringify(report)).not.toContain('proxy-secret')
        expect(report.createdModelPresets[0].userValues.additionalParams).toEqual([['x-provider', 'abc']])
    })

    test('uses provider-specific request model fields for OpenRouter and reverse proxy', () => {
        const report = analyzeModelPresetMigration({
            aiModel: 'openrouter',
            openrouterRequestModel: 'anthropic/claude-3-opus',
            openrouterKey: 'sk-or-secret',
            botPresets: [{
                id: 'bot-router',
                aiModel: 'openrouter',
                openrouterRequestModel: 'openai/gpt-4o-mini',
            }, {
                id: 'bot-proxy',
                aiModel: 'reverse_proxy',
                forceReplaceUrl: 'https://proxy.test/v1/chat/completions',
                proxyRequestModel: 'proxy-model-from-legacy',
            }],
        })

        expect(report.createdModelPresets.find((preset) => preset.sourcePath === 'db.aiModel')).toMatchObject({
            profileId: 'openrouter:openai-compatible',
            modelId: 'anthropic/claude-3-opus',
            credentialSource: { kind: 'legacyKey', sourcePath: 'db.openrouterKey' },
            userValues: {
                modelId: 'anthropic/claude-3-opus',
                format: undefined,
            },
        })
        expect(report.createdModelPresets.find((preset) => preset.sourcePath === 'botPresets.bot-router.aiModel')).toMatchObject({
            profileId: 'openrouter:openai-compatible',
            modelId: 'openai/gpt-4o-mini',
        })
        expect(report.createdModelPresets.find((preset) => preset.sourcePath === 'botPresets.bot-proxy.reverse_proxy')).toMatchObject({
            profileId: 'openai-compatible:custom',
            modelId: 'proxy-model-from-legacy',
            userValues: {
                endpointUrl: 'https://proxy.test/v1/chat/completions',
                modelId: 'proxy-model-from-legacy',
                additionalParams: [],
            },
        })
        expect(report.botPresetBindings).toContainEqual({
            scope: 'botPreset',
            ownerId: 'bot-proxy',
            targetTask: 'model',
            sourcePath: 'botPresets.bot-proxy.aiModel',
            binding: {
                kind: 'modelPreset',
                id: report.createdModelPresets.find((preset) => preset.sourcePath === 'botPresets.bot-proxy.reverse_proxy')?.id,
            },
        })
        expect(JSON.stringify(report)).not.toContain('sk-or-secret')
    })

    test('creates plugin bindings without converting plugin models to ModelPreset', () => {
        const report = analyzeModelPresetMigration({
            aiModel: 'pluginmodel:::cpm',
            botPresets: [{
                id: 'bot-a',
                aiModel: 'pluginmodel:::other-plugin',
                bias: [],
            }],
        })

        expect(report.createdModelPresets).toEqual([])
        expect(report.pluginBindings).toEqual([
            {
                scope: 'global',
                targetTask: 'model',
                sourcePath: 'db.aiModel',
                pluginModelId: 'pluginmodel:::cpm',
                binding: { kind: 'pluginModel', id: 'pluginmodel:::cpm' },
            },
            {
                scope: 'botPreset',
                ownerId: 'bot-a',
                targetTask: 'model',
                sourcePath: 'botPresets.bot-a.aiModel',
                pluginModelId: 'pluginmodel:::other-plugin',
                binding: { kind: 'pluginModel', id: 'pluginmodel:::other-plugin' },
            },
        ])
    })

    test('reports unsupported native providers and skipped bias', () => {
        const report = analyzeModelPresetMigration({
            customModels: [{
                id: 'xcustom:::kobold',
                format: LLMFormat.Kobold,
                key: 'kobold-secret',
                name: 'Kobold',
            }],
            aiModel: 'novelai',
            bias: [['token', 42]],
            enableCustomFlags: true,
            customFlags: [6],
        })

        expect(report.createdModelPresets).toEqual([])
        expect(report.manualRequired).toEqual([
            {
                sourcePath: 'customModels.xcustom:::kobold',
                reason: `Unsupported custom model format: ${LLMFormat.Kobold}`,
                legacySource: 'xcustom:::kobold',
            },
            {
                sourcePath: 'db.aiModel',
                reason: 'Unsupported legacy model: novelai',
                legacySource: 'db.aiModel',
            },
        ])
        expect(report.skippedBias).toEqual([
            {
                sourcePath: 'db.bias',
                reason: 'Bias is not migrated to v4 ModelPreset or PromptPreset',
            },
        ])
        expect(report.preservedLegacyFields).toEqual([
            {
                sourcePath: 'db.customFlags',
                reason: 'Custom flags are preserved and only auto-mapped when profile schema supports them',
            },
        ])
        expect(JSON.stringify(report)).not.toContain('kobold-secret')
    })

    test('adds structured global and task binding metadata', () => {
        const report = analyzeModelPresetMigration({
            aiModel: 'gpt-4o',
            subModel: 'claude-3-5-sonnet',
            seperateModelsForAxModels: true,
            seperateModels: {
                memory: 'gemini-2.5-pro',
                translate: 'pluginmodel:::translator',
            },
            openAIKey: 'sk-openai',
            claudeAPIKey: 'sk-anthropic',
        })

        expect(report.globalBindings).toEqual([
            expect.objectContaining({
                scope: 'global',
                targetTask: 'model',
                sourcePath: 'db.aiModel',
                binding: { kind: 'modelPreset', id: expect.any(String) },
            }),
            expect.objectContaining({
                scope: 'global',
                targetTask: 'submodel',
                sourcePath: 'db.subModel',
                binding: { kind: 'modelPreset', id: expect.any(String) },
            }),
            expect.objectContaining({
                scope: 'global',
                targetTask: 'memory',
                sourcePath: 'db.seperateModels.memory',
                binding: { kind: 'modelPreset', id: expect.any(String) },
            }),
        ])
        expect(report.pluginBindings).toContainEqual({
            scope: 'global',
            targetTask: 'translate',
            sourcePath: 'db.seperateModels.translate',
            pluginModelId: 'pluginmodel:::translator',
            binding: { kind: 'pluginModel', id: 'pluginmodel:::translator' },
        })
        expect(report.createdModelPresets.find((preset) => preset.sourcePath === 'db.aiModel')?.credentialSource).toEqual({
            kind: 'legacyKey',
            sourcePath: 'db.openAIKey',
        })
        expect(JSON.stringify(report)).not.toContain('sk-openai')
        expect(JSON.stringify(report)).not.toContain('sk-anthropic')
    })

    test('redacts secret-like freeform params and additionalParams', () => {
        const report = analyzeModelPresetMigration({
            customModels: [{
                id: 'xcustom:::leaky',
                format: LLMFormat.OpenAICompatible,
                name: 'Leaky',
                params: 'Authorization=Bearer sk-leak',
            }],
            aiModel: 'reverse_proxy',
            forceReplaceUrl: 'https://proxy.test',
            additionalParams: [
                ['Authorization', 'Bearer sk-header-leak'],
                ['x-safe', 'visible'],
            ],
        })

        expect(JSON.stringify(report)).not.toContain('sk-leak')
        expect(JSON.stringify(report)).not.toContain('sk-header-leak')
        expect(report.createdModelPresets.find((preset) => preset.sourcePath === 'customModels.xcustom:::leaky')?.userValues.params).toBe('[redacted]')
        expect(report.createdModelPresets.find((preset) => preset.sourcePath === 'db.reverse_proxy')?.userValues.additionalParams).toEqual([
            ['Authorization', '[redacted]'],
            ['x-safe', 'visible'],
        ])
    })

    test('hardens legacy model prefix matching for native and lookalike ids', () => {
        const report = analyzeModelPresetMigration({
            aiModel: 'gpt2-large-conversational',
            subModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        })

        expect(report.createdModelPresets).toEqual([])
        expect(report.manualRequired).toEqual([
            {
                sourcePath: 'db.aiModel',
                reason: 'Unsupported legacy model: gpt2-large-conversational',
                legacySource: 'db.aiModel',
            },
            {
                sourcePath: 'db.subModel',
                reason: 'Native Bedrock Claude model requires manual migration: anthropic.claude-3-5-sonnet-20241022-v2:0',
                legacySource: 'db.subModel',
            },
        ])
    })

    test('does not mutate input during dry-run', () => {
        const db = {
            customModels: [{
                id: 'xcustom:::main',
                internalId: 'model',
                url: 'https://example.test',
                format: LLMFormat.OpenAICompatible,
                key: 'secret',
                name: 'Main',
                params: '',
                flags: [],
            }],
            aiModel: 'xcustom:::main',
            bias: [['token', 1]] as [string, number][],
        }
        const before = JSON.stringify(db)

        analyzeModelPresetMigration(db)

        expect(JSON.stringify(db)).toBe(before)
    })
})
