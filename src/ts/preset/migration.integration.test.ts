/**
 * End-to-end migration integration coverage (plan §14-8/§14-9/§14-11).
 *
 * Unit tests in [migration.test.ts](./migration.test.ts) cover each source
 * type in isolation. This file exercises:
 *
 *  - a single DB carrying *every* migration source type at once (customModels
 *    with/without key, reverse_proxy, plugin model, native providers,
 *    unsupported provider, task bindings, BotPreset bindings),
 *  - analyze + apply against the bundled registry resolver,
 *  - and the resulting DB state's *internal coherence*: every binding points
 *    at a real preset id, no secrets land in the report/summary, idempotent
 *    reapply does not duplicate entries.
 *
 * This is the regression guard for the §14-5 push: it locks in that the v4
 * migration pipeline still produces a self-consistent DB after the adapter
 * wiring changes.
 */
import { describe, expect, test } from 'vitest'
import { LLMFormat } from '../model/types'
import {
    analyzeModelPresetMigration,
    applyModelPresetMigration,
    type ModelPresetMigrationApplyTarget,
} from './migration'
import { bundledMigrationResolver } from './registry'
import type { ModelBinding, ModelBindingFields } from './types'

type BotPresetWithBindings = { id?: string; name?: string } & ModelBindingFields

function multiSourceDb(): ModelPresetMigrationApplyTarget {
    return {
        customModels: [
            {
                id: 'xcustom:::main',
                internalId: 'gpt-custom',
                url: 'https://example.test/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: 'sk-secret-custom',
                name: 'Main Custom',
                params: '',
                flags: [],
            },
            {
                id: 'xcustom:::local',
                internalId: 'llama-3',
                url: 'http://localhost:8000/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: '',
                name: 'Local Llama',
                params: '',
                flags: [],
            },
        ],
        // Reverse proxy with key — should resolve to openai-compatible:custom.
        forceReplaceUrl: 'https://reverse.test/v1/chat/completions',
        proxyKey: 'sk-reverse-secret',
        customAPIFormat: LLMFormat.OpenAICompatible,
        customProxyRequestModel: 'gpt-4o-proxy',
        // Global model bound to plugin model — should NOT create a preset.
        aiModel: 'pluginmodel:::translator',
        // Sub-model bound to native Anthropic with key.
        subModel: 'claude-sonnet-4-5',
        claudeAPIKey: 'sk-ant-secret',
        // Task bindings: memory → google, translate → NovelAI (unsupported).
        seperateModelsForAxModels: true,
        seperateModels: {
            memory: 'gemini-2.5-pro',
            translate: 'novelai',
        },
        // Top-level Google credential — migrated into apiKeyPool for the
        // google:standard preset created by the memory binding.
        google: { accessToken: 'AIza-google-secret' },
        // BotPreset with its own model override.
        botPresets: [
            { id: 'bot-a', name: 'Alpha', aiModel: 'gpt-4o' },
            { id: 'bot-b', name: 'Beta', aiModel: 'pluginmodel:::summarizer' },
        ],
        openAIKey: 'sk-openai-secret',
    }
}

function findPresetBindingId(binding: ModelBinding | undefined): string | undefined {
    if (binding?.kind === 'modelPreset') return binding.id
    return undefined
}

describe('Model preset v4 migration — multi-source end-to-end', () => {
    test('analyze + apply against bundled registry produces a self-consistent DB', () => {
        const db = multiSourceDb()
        const report = analyzeModelPresetMigration(db)
        applyModelPresetMigration(db, report, bundledMigrationResolver())

        // ── 1. modelPresets sanity ──────────────────────────────────────
        const presets = db.modelPresets ?? []
        expect(presets.length).toBeGreaterThan(0)

        // Every preset has a deterministic id, a non-empty profile snapshot,
        // and a sourceProfile pointing at the bundled registry.
        for (const preset of presets) {
            expect(preset.id).toBeTruthy()
            expect(preset.profileSnapshot.profileId).toBeTruthy()
            expect(preset.profileSnapshot.adapterKind).toBeTruthy()
            expect(preset.sourceProfile?.registryId).toBe('bundled')
            expect(preset.sourceProfile?.profileId).toBe(preset.profileSnapshot.profileId)
        }

        // No two presets share an id.
        const ids = presets.map((p) => p.id)
        expect(new Set(ids).size).toBe(ids.length)

        // ── 2. profile-id routing keyed by migrationSource.sourcePath ──
        // Sets like `profileIds.has('openai-compatible:custom')` can't tell a
        // custom-with-key preset apart from a reverse-proxy-with-key preset
        // because both land on the same profile. Pin each expected source
        // path to a concrete profile id (and apiKeyRef presence) so a regression
        // in one source can't be masked by a sibling.
        const presetBySourcePath = new Map(
            presets
                .filter((p) => p.migrationSource?.sourcePath)
                .map((p) => [p.migrationSource!.sourcePath, p] as const),
        )
        const expectSourcePath = (
            sourcePath: string,
            expectedProfileId: string,
            { withApiKey }: { withApiKey: boolean },
        ): void => {
            const preset = presetBySourcePath.get(sourcePath)
            expect(preset, `no preset with sourcePath=${sourcePath}`).toBeTruthy()
            if (!preset) return
            expect(preset.profileSnapshot.profileId).toBe(expectedProfileId)
            if (withApiKey) {
                expect(preset.apiKeyRef).toBeTruthy()
            } else {
                // Strict undefined (not just falsy) — an empty-string apiKeyRef
                // would be an invalid persisted shape and must not slip past.
                expect(preset.apiKeyRef).toBeUndefined()
            }
        }
        expectSourcePath('customModels.xcustom:::main', 'openai-compatible:custom', {
            withApiKey: true,
        })
        expectSourcePath('customModels.xcustom:::local', 'openai-compatible:custom-noauth', {
            withApiKey: false,
        })
        expectSourcePath('db.reverse_proxy', 'openai-compatible:custom', { withApiKey: true })
        // Native bindings come from global/task aiModel paths, not from
        // customModels/reverse_proxy. Each native preset must carry its own
        // apiKeyRef (anthropic from claudeAPIKey, openai from openAIKey,
        // google from db.google.accessToken).
        expectSourcePath('db.subModel', 'anthropic:standard', { withApiKey: true })
        expectSourcePath('botPresets.bot-a.aiModel', 'openai:standard', { withApiKey: true })
        expectSourcePath('db.seperateModels.memory', 'google:standard', { withApiKey: true })

        // ── 3. binding referential integrity ────────────────────────────
        // aiModel → plugin binding (no preset).
        expect(db.modelBinding).toEqual({
            kind: 'pluginModel',
            id: 'pluginmodel:::translator',
        })
        // subModel → Anthropic preset.
        const subBindingId = findPresetBindingId(db.subModelBinding)
        expect(subBindingId).toBeTruthy()
        expect(presets.find((p) => p.id === subBindingId)?.profileSnapshot.profileId).toBe(
            'anthropic:standard',
        )
        // task memory → google preset.
        const memoryBindingId = findPresetBindingId(db.taskModelBindings?.memory)
        expect(memoryBindingId).toBeTruthy()
        expect(presets.find((p) => p.id === memoryBindingId)?.profileSnapshot.profileId).toBe(
            'google:standard',
        )
        // task translate → NovelAI is unsupported, falls to manualRequired.
        expect(db.taskModelBindings?.translate?.kind).toBe('manualRequired')

        // BotPreset bindings. (Cast through the binding-augmented view since
        // the underlying LegacyBotPreset type predates v4 fields.)
        const botPresets = (db.botPresets ?? []) as BotPresetWithBindings[]
        const botA = botPresets.find((b) => b.id === 'bot-a')
        const botAPresetId = findPresetBindingId(botA?.modelBinding)
        expect(botAPresetId).toBeTruthy()
        expect(presets.find((p) => p.id === botAPresetId)?.profileSnapshot.profileId).toBe(
            'openai:standard',
        )
        const botB = botPresets.find((b) => b.id === 'bot-b')
        expect(botB?.modelBinding).toEqual({
            kind: 'pluginModel',
            id: 'pluginmodel:::summarizer',
        })

        // ── 4. apiKeyPool integrity ─────────────────────────────────────
        const apiKeys = db.apiKeyPool ?? {}
        const keyEntries = Object.values(apiKeys)
        expect(keyEntries.length).toBeGreaterThan(0)
        // Every preset that should have a key actually has apiKeyRef in the pool.
        for (const preset of presets) {
            if (!preset.apiKeyRef) continue
            expect(apiKeys[preset.apiKeyRef]).toBeTruthy()
        }
        // Plain keys are stored as-is in the pool (so the chat-send path can
        // use them), but neither the dry-run report nor the persisted summary
        // may leak them. Check both, since the summary derives from the report
        // and a leak in only the report could be masked by the summary check.
        const secrets = [
            'sk-ant-secret',
            'sk-openai-secret',
            'sk-reverse-secret',
            'sk-secret-custom',
            'AIza-google-secret',
        ]
        const summaryJson = JSON.stringify(db.modelPresetMigrationReport)
        const dryRunJson = JSON.stringify(report)
        for (const secret of secrets) {
            expect(summaryJson).not.toContain(secret)
            expect(dryRunJson).not.toContain(secret)
        }

        // ── 5. migration summary version + timestamp ────────────────────
        expect(db.modelPresetMigrationVersion).toBe(1)
        expect(db.modelPresetMigrationAppliedAt).toBeGreaterThan(0)
        expect(db.modelPresetMigrationReport?.createdModelPresetCount).toBe(presets.length)
        // Manual required count includes the NovelAI binding.
        expect(db.modelPresetMigrationReport?.manualRequiredCount).toBeGreaterThanOrEqual(1)
    })

    test('migrated presets pass referential validation: every binding id resolves', () => {
        const db = multiSourceDb()
        const report = analyzeModelPresetMigration(db)
        applyModelPresetMigration(db, report, bundledMigrationResolver())

        const presetIds = new Set((db.modelPresets ?? []).map((p) => p.id))

        const collectBindingPresetIds = (b: ModelBinding | undefined): string[] =>
            b?.kind === 'modelPreset' ? [b.id] : []

        const bindingIds = [
            ...collectBindingPresetIds(db.modelBinding),
            ...collectBindingPresetIds(db.subModelBinding),
            ...Object.values(db.taskModelBindings ?? {}).flatMap(collectBindingPresetIds),
            ...((db.botPresets ?? []) as BotPresetWithBindings[]).flatMap(
                (bot) => collectBindingPresetIds(bot.modelBinding),
            ),
        ]

        for (const id of bindingIds) {
            expect(presetIds.has(id)).toBe(true)
        }
    })

    test('idempotent reapply: second analyze+apply pass produces the same DB shape', () => {
        const db = multiSourceDb()
        const firstReport = analyzeModelPresetMigration(db)
        applyModelPresetMigration(db, firstReport, bundledMigrationResolver())
        const presetCountAfterFirst = db.modelPresets?.length ?? 0
        const apiKeyCountAfterFirst = Object.keys(db.apiKeyPool ?? {}).length
        const firstIds = new Set((db.modelPresets ?? []).map((p) => p.id))

        const secondReport = analyzeModelPresetMigration(db)
        applyModelPresetMigration(db, secondReport, bundledMigrationResolver())

        // Counts unchanged → upserted, not duplicated.
        expect(db.modelPresets?.length).toBe(presetCountAfterFirst)
        expect(Object.keys(db.apiKeyPool ?? {}).length).toBe(apiKeyCountAfterFirst)
        // All ids preserved across reapply.
        for (const p of db.modelPresets ?? []) {
            expect(firstIds.has(p.id)).toBe(true)
        }
    })

    test('analyze step alone never mutates input (regression for dry-run contract)', () => {
        const db = multiSourceDb()
        const before = JSON.stringify(db)
        analyzeModelPresetMigration(db)
        expect(JSON.stringify(db)).toBe(before)
    })
})
