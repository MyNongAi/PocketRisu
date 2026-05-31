/**
 * Migration integration coverage for plan v5.
 *
 * v4 carried a multi-source "kitchen sink" fixture because the analyzer
 * touched customModels + reverse_proxy + native aiModel + botPreset overrides
 * + task bindings all at once. v5 narrows migration to `customModels[]`-only,
 * so this file exists to lock in three integration-level invariants that the
 * unit tests in [migration.test.ts](./migration.test.ts) don't cover:
 *
 *  1. Multiple customModels (different formats / credential states) coexist
 *     in a single analyze+apply pass without colliding or aliasing.
 *  2. Every persisted preset's binding id (apiKeyRef) actually resolves to a
 *     real `apiKeyPool` entry — referential integrity across the two writes.
 *  3. Dry-run report and persisted summary both stay free of secret material
 *     when several customModels are processed together.
 */
import { describe, expect, test } from 'vitest'
import { LLMFormat } from '../model/types'
import {
    analyzeModelPresetMigration,
    applyModelPresetMigration,
    type ModelPresetMigrationApplyTarget,
} from './migration'
import { bundledMigrationResolver } from './registry'

function multiCustomModelDb(): ModelPresetMigrationApplyTarget {
    return {
        customModels: [
            {
                id: 'xcustom:::main',
                internalId: 'gpt-custom',
                url: 'https://hosted.test/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: 'sk-secret-main',
                name: 'Main Custom',
            },
            {
                id: 'xcustom:::local',
                internalId: 'llama-3',
                url: 'http://localhost:8000/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: '',
                name: 'Local',
            },
            {
                id: 'xcustom:::claude',
                internalId: 'claude-sonnet-4-5',
                format: LLMFormat.Anthropic,
                key: 'sk-secret-ant',
                name: 'Claude',
            },
            {
                id: 'xcustom:::kobold',
                format: LLMFormat.Kobold,
                key: 'k',
                name: 'Kobold (unsupported)',
            },
            {
                // Regression guard against silent auto-mapping. VertexAIGemini
                // uses Bearer + aiplatform.googleapis.com — auto-mapping it to
                // AI Studio (`google:gemini-3`, x-goog-api-key + generativelanguage)
                // would produce a preset that talks to the wrong endpoint
                // with the wrong auth header. v5 policy: manualRequired.
                id: 'xcustom:::vertex-native',
                format: LLMFormat.VertexAIGemini,
                key: 'vertex-secret-should-be-redacted',
                name: 'Vertex Native (must NOT auto-migrate)',
            },
        ],
        google: { accessToken: 'goog-fallback' },
    }
}

describe('Model preset v5 migration — multi-customModel end-to-end', () => {
    test('analyze + apply against bundled registry produces a self-consistent DB', () => {
        const db = multiCustomModelDb()
        const report = analyzeModelPresetMigration(db)
        applyModelPresetMigration(db, report, bundledMigrationResolver())

        const presets = db.modelPresets ?? []
        // 3 supported customModels → 3 presets. Kobold + Vertex-native land in
        // manualRequired (Vertex needs SA flow, not AI Studio's API key path).
        expect(presets).toHaveLength(3)
        expect(new Set(presets.map((p) => p.id)).size).toBe(3) // unique ids

        // Source-level routing (sourcePath → expected profile + apiKeyRef shape).
        const presetBySourcePath = new Map(
            presets
                .filter((p) => p.migrationSource?.sourcePath)
                .map((p) => [p.migrationSource!.sourcePath, p] as const),
        )
        const expectPreset = (
            sourcePath: string,
            expectedProfileId: string,
            { withApiKey }: { withApiKey: boolean },
        ): void => {
            const preset = presetBySourcePath.get(sourcePath)
            expect(preset, `no preset with sourcePath=${sourcePath}`).toBeTruthy()
            if (!preset) return
            expect(preset.profileSnapshot.profileId).toBe(expectedProfileId)
            if (withApiKey) expect(preset.apiKeyRef).toBeTruthy()
            else expect(preset.apiKeyRef).toBeUndefined()
        }
        expectPreset('customModels.xcustom:::main', 'openai-compatible:custom', { withApiKey: true })
        expectPreset('customModels.xcustom:::local', 'openai-compatible:custom-noauth', { withApiKey: false })
        expectPreset('customModels.xcustom:::claude', 'anthropic:sonnet-adaptive', { withApiKey: true })

        // Both unsupported customModels (Kobold, Vertex-native) land in
        // manualRequired, not in modelPresets.
        expect(db.modelPresetMigrationReport?.manualRequiredCount).toBe(2)
        expect(presetBySourcePath.has('customModels.xcustom:::kobold')).toBe(false)
        expect(presetBySourcePath.has('customModels.xcustom:::vertex-native')).toBe(false)
    })

    test('every preset apiKeyRef resolves to a real apiKeyPool entry', () => {
        const db = multiCustomModelDb()
        applyModelPresetMigration(
            db,
            analyzeModelPresetMigration(db),
            bundledMigrationResolver(),
        )

        for (const preset of db.modelPresets ?? []) {
            if (!preset.apiKeyRef) continue
            expect(db.apiKeyPool?.[preset.apiKeyRef]).toBeTruthy()
            expect(db.apiKeyPool?.[preset.apiKeyRef]?.key).toBeTruthy()
        }
    })

    test('neither dry-run report nor persisted summary leaks any per-model key', () => {
        const db = multiCustomModelDb()
        const report = analyzeModelPresetMigration(db)
        applyModelPresetMigration(db, report, bundledMigrationResolver())

        const secrets = [
            'sk-secret-main',
            'sk-secret-ant',
            'goog-fallback',
            'vertex-secret-should-be-redacted',
        ]
        const dryRunJson = JSON.stringify(report)
        const summaryJson = JSON.stringify(db.modelPresetMigrationReport)
        for (const secret of secrets) {
            expect(dryRunJson).not.toContain(secret)
            expect(summaryJson).not.toContain(secret)
        }
    })

    test('idempotent reapply: second pass produces the same DB shape', () => {
        const db = multiCustomModelDb()
        applyModelPresetMigration(
            db,
            analyzeModelPresetMigration(db),
            bundledMigrationResolver(),
        )
        const firstCount = db.modelPresets?.length ?? 0
        const firstKeyCount = Object.keys(db.apiKeyPool ?? {}).length
        const firstIds = new Set((db.modelPresets ?? []).map((p) => p.id))

        applyModelPresetMigration(
            db,
            analyzeModelPresetMigration(db),
            bundledMigrationResolver(),
        )
        expect(db.modelPresets?.length).toBe(firstCount)
        expect(Object.keys(db.apiKeyPool ?? {}).length).toBe(firstKeyCount)
        for (const p of db.modelPresets ?? []) {
            expect(firstIds.has(p.id)).toBe(true)
        }
    })
})
