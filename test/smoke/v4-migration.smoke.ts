/**
 * v4 ModelPreset 백엔드 smoke harness.
 *
 * 사용자가 NodeOnly UI의 backup 기능으로 export한 `.bin` 파일을 입력으로 받아
 * 다음 네 영역을 dry-run으로 검증한다.
 *
 *   1. analyze report   — migration이 어떤 ModelPreset 후보를 만드는지
 *   2. dry-run apply    — apiKeyPool / binding integrity / orphan
 *   3. adapter wire     — 각 migrated preset의 buildPreparedRequest 출력
 *   4. .bin round-trip  — apply 결과를 다시 encode → 같은 라이브러리로 decode
 *
 * 출력은 stdout에만 쓴다. 입력 .bin / 라이브 db는 절대 건드리지 않는다.
 * 비밀 key는 redact해서 출력한다.
 *
 * 실행:
 *   SMOKE_DB_PATH=/path/to/your-export.bin \
 *     pnpm exec vitest run --config vitest.config.smoke.ts
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, test } from 'vitest'

import {
    analyzeModelPresetMigration,
    applyModelPresetMigration,
    type ModelPresetMigrationApplyTarget,
} from '../../src/ts/preset/migration'
import { bundledMigrationResolver } from '../../src/ts/preset/registry'
import { buildPreparedRequest } from '../../src/ts/preset/adapter/buildRequest'
import type { ModelBinding, ModelPreset } from '../../src/ts/preset/types'

const require = createRequire(import.meta.url)
// utils.cjs는 CJS 모듈. createRequire로 ESM에서 안전하게 로드.
const utilsCjs = require('../../server/node/utils.cjs') as {
    decodeRisuSave: (data: Uint8Array, options?: unknown) => Promise<Record<string, unknown>>
    encodeRisuSaveLegacy: (data: unknown, compression?: 'compression' | 'noCompression') => Uint8Array
}

const dbPath = process.env.SMOKE_DB_PATH

function redactedClone(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'string' && looksLikeSecret(value)) return '[redacted]'
        return value
    }
    if (seen.has(value as object)) return '[circular]'
    seen.add(value as object)
    if (Array.isArray(value)) return value.map((v) => redactedClone(v, seen))
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (isSecretKey(k) && typeof v === 'string' && v.length > 0) {
            out[k] = '[redacted]'
            continue
        }
        out[k] = redactedClone(v, seen)
    }
    return out
}

function isSecretKey(key: string): boolean {
    return /key|token|secret|password|credential|authorization|serviceaccountjson/i.test(key)
}

function looksLikeSecret(value: string): boolean {
    if (value.length < 20) return false
    return /^sk-[A-Za-z0-9_-]/.test(value)
        || /^AIza[0-9A-Za-z_-]/.test(value)
        || /^Bearer\s+\S/.test(value)
}

function summarizePreset(preset: ModelPreset): Record<string, unknown> {
    return {
        id: preset.id,
        name: preset.name,
        profileId: preset.profileSnapshot.profileId,
        providerBaseId: preset.profileSnapshot.providerBaseId,
        providerBaseVersion: preset.profileSnapshot.providerBaseVersion,
        adapterKind: preset.profileSnapshot.adapterKind,
        authKind: preset.profileSnapshot.auth.kind,
        endpoint: preset.profileSnapshot.endpoint,
        modelId: preset.profileSnapshot.modelId,
        hasApiKeyRef: Boolean(preset.apiKeyRef),
        migrationSource: preset.migrationSource,
        userValueKeys: Object.keys(preset.userValues),
        orphanValueKeys: preset.orphanValues ? Object.keys(preset.orphanValues) : [],
    }
}

function summarizeBinding(label: string, binding: ModelBinding | undefined): string {
    if (!binding) return `${label}: <none>`
    if (binding.kind === 'modelPreset') return `${label}: modelPreset(${binding.id})`
    if (binding.kind === 'pluginModel') return `${label}: pluginModel(${binding.id})`
    if (binding.kind === 'manualRequired') return `${label}: manualRequired (${binding.reason})`
    return `${label}: ${JSON.stringify(binding)}`
}

function logSection(title: string): void {
    console.log('')
    console.log(`==== ${title} ====`)
}

describe.skipIf(!dbPath)('v4 ModelPreset smoke', () => {
    test('analyze + dry-run apply + adapter wire + .bin round-trip', async () => {
        if (!dbPath) throw new Error('unreachable')
        if (!fs.existsSync(dbPath)) {
            throw new Error(`SMOKE_DB_PATH does not exist: ${dbPath}`)
        }
        const fileSize = fs.statSync(dbPath).size

        // ── 1. load + decode ───────────────────────────────────────────
        logSection('input')
        console.log(`SMOKE_DB_PATH: ${dbPath}`)
        console.log(`file size: ${fileSize} bytes`)

        const buffer = new Uint8Array(fs.readFileSync(dbPath))
        const decoded = await utilsCjs.decodeRisuSave(buffer)
        const db = decoded as ModelPresetMigrationApplyTarget
        console.log(`decoded top-level keys: ${Object.keys(decoded).length}`)
        console.log(`already-migrated modelPresets: ${(db.modelPresets ?? []).length}`)
        console.log(`existing apiKeyPool entries: ${Object.keys(db.apiKeyPool ?? {}).length}`)
        console.log(`migrationVersion: ${db.modelPresetMigrationVersion ?? '<none>'}`)

        // ── 2. analyze report ──────────────────────────────────────────
        logSection('analyze report')
        const analyzeInput = structuredClone(db)
        const report = analyzeModelPresetMigration(analyzeInput)
        console.log(`createdModelPresets: ${report.createdModelPresets.length}`)
        console.log(`globalBindings: ${report.globalBindings.length}`)
        console.log(`botPresetBindings: ${report.botPresetBindings.length}`)
        console.log(`pluginBindings: ${report.pluginBindings.length}`)
        console.log(`manualRequired: ${report.manualRequired.length}`)
        console.log(`preservedLegacyFields: ${report.preservedLegacyFields.length}`)
        console.log(`warnings: ${report.warnings.length}`)
        console.log('--- created presets ---')
        for (const p of report.createdModelPresets) {
            console.log(
                `  • [${p.sourceKind}] ${p.sourcePath} → ${p.profileId}`
                + (p.modelId ? ` (modelId=${p.modelId})` : '')
                + (p.credentialSource ? ` (cred=${p.credentialSource.sourcePath})` : '')
            )
        }
        if (report.manualRequired.length > 0) {
            console.log('--- manual required ---')
            for (const m of report.manualRequired) {
                console.log(`  • ${m.sourcePath}: ${m.reason}`)
            }
        }

        // Secret leak guard — dry-run report must not contain raw keys.
        const reportJson = JSON.stringify(report)
        for (const candidate of collectLegacySecrets(db)) {
            expect(
                reportJson.includes(candidate),
                `analyze report leaked secret "${candidate.slice(0, 6)}…"`,
            ).toBe(false)
        }

        // ── 3. dry-run apply ──────────────────────────────────────────
        logSection('dry-run apply (against in-memory copy; original db untouched)')
        const applyTarget = structuredClone(db) as ModelPresetMigrationApplyTarget
        applyModelPresetMigration(applyTarget, report, bundledMigrationResolver())
        const presets = applyTarget.modelPresets ?? []
        const apiKeyPool = applyTarget.apiKeyPool ?? {}
        console.log(`resulting modelPresets: ${presets.length}`)
        console.log(`resulting apiKeyPool entries: ${Object.keys(apiKeyPool).length}`)
        console.log(`modelPresetMigrationVersion: ${applyTarget.modelPresetMigrationVersion}`)
        console.log(`appliedAt: ${applyTarget.modelPresetMigrationAppliedAt}`)
        console.log(summarizeBinding('global modelBinding', applyTarget.modelBinding))
        console.log(summarizeBinding('global subModelBinding', applyTarget.subModelBinding))
        for (const [task, binding] of Object.entries(applyTarget.taskModelBindings ?? {})) {
            console.log(summarizeBinding(`task[${task}]`, binding as ModelBinding))
        }

        // Referential integrity — every binding pointing at modelPreset must resolve.
        const presetIds = new Set(presets.map((p) => p.id))
        const collectBindingIds = (b: ModelBinding | undefined): string[] =>
            b?.kind === 'modelPreset' ? [b.id] : []
        const allBindingIds = [
            ...collectBindingIds(applyTarget.modelBinding),
            ...collectBindingIds(applyTarget.subModelBinding),
            ...Object.values(applyTarget.taskModelBindings ?? {}).flatMap(collectBindingIds),
            ...(applyTarget.botPresets ?? []).flatMap((bp) =>
                collectBindingIds((bp as { modelBinding?: ModelBinding }).modelBinding)
            ),
        ]
        const orphanBindings = allBindingIds.filter((id) => !presetIds.has(id))
        console.log(`binding referential integrity: ${orphanBindings.length === 0 ? 'OK' : 'BROKEN'}`)
        expect(orphanBindings).toEqual([])

        console.log('--- preset summaries (redacted) ---')
        for (const p of presets) {
            console.log(JSON.stringify(summarizePreset(p)))
        }

        // Secret leak guard — persisted summary (post-apply) must not contain raw keys.
        const summaryJson = JSON.stringify(applyTarget.modelPresetMigrationReport)
        for (const candidate of collectLegacySecrets(db)) {
            expect(
                summaryJson.includes(candidate),
                `migration summary leaked secret "${candidate.slice(0, 6)}…"`,
            ).toBe(false)
        }

        // ── 4. adapter wire smoke (no real API call) ───────────────────
        logSection('adapter wire smoke (no real API call; placeholder credential)')
        let wireOK = 0
        let wireSkipped = 0
        const wireFailures: Array<{ presetId: string; error: string }> = []
        for (const preset of presets) {
            // SA auth needs async credential resolve via resolveAdapterCredential;
            // skip here. Coverage for that path lives in adapter unit tests.
            if (preset.profileSnapshot.auth.kind === 'google-service-account') {
                wireSkipped++
                continue
            }
            try {
                const prepared = buildPreparedRequest({
                    preset,
                    credential: { apiKey: 'smoke-placeholder' },
                })
                wireOK++
                console.log(
                    `  • [${preset.profileSnapshot.profileId}] ${prepared.method} ${prepared.url}`
                    + ` (auth=${preset.profileSnapshot.auth.kind})`
                )
            } catch (err) {
                wireFailures.push({
                    presetId: preset.id,
                    error: err instanceof Error ? err.message : String(err),
                })
            }
        }
        console.log(`wire smoke: ${wireOK} ok / ${wireSkipped} skipped (SA) / ${wireFailures.length} failed`)
        if (wireFailures.length > 0) {
            console.log('--- wire failures ---')
            for (const f of wireFailures) console.log(`  • ${f.presetId}: ${f.error}`)
        }
        expect(wireFailures).toEqual([])

        // ── 5. .bin round-trip ─────────────────────────────────────────
        logSection('.bin round-trip (in-memory encode → decode)')
        // 사용자 데이터 보호: 디스크에는 절대 쓰지 않는다. 메모리에서만 round-trip.
        const encoded = utilsCjs.encodeRisuSaveLegacy(applyTarget, 'compression')
        const decoded2 = await utilsCjs.decodeRisuSave(encoded)
        const round = decoded2 as ModelPresetMigrationApplyTarget
        console.log(`encoded size: ${encoded.length} bytes`)
        console.log(`decoded keys after round-trip: ${Object.keys(decoded2).length}`)
        expect((round.modelPresets ?? []).length).toBe(presets.length)
        expect(round.modelPresetMigrationVersion).toBe(applyTarget.modelPresetMigrationVersion)
        expect(round.modelPresetMigrationAppliedAt).toBe(applyTarget.modelPresetMigrationAppliedAt)
        expect(Object.keys(round.apiKeyPool ?? {}).length).toBe(Object.keys(apiKeyPool).length)
        console.log('round-trip referential identity: OK')

        // ── done ──────────────────────────────────────────────────────
        logSection('summary')
        console.log(`✓ analyze created ${report.createdModelPresets.length} preset(s)`)
        console.log(`✓ dry-run apply produced ${presets.length} preset(s), ${Object.keys(apiKeyPool).length} key(s)`)
        console.log(`✓ wire smoke ${wireOK} ok / ${wireSkipped} skipped`)
        console.log(`✓ .bin round-trip preserved counts + audit fields`)
        console.log('')
        console.log('Original file untouched. No data written to disk.')
    })
})

/**
 * Collect non-empty string secrets from legacy DB locations the migration
 * analyzer touches. Used as a leak guard for report / summary JSON.
 */
function collectLegacySecrets(db: ModelPresetMigrationApplyTarget): string[] {
    const candidates: Array<string | undefined> = [
        db.openAIKey,
        db.openrouterKey,
        db.nanogptKey,
        db.claudeAPIKey,
        db.proxyKey,
        db.google?.accessToken,
    ]
    for (const cm of db.customModels ?? []) {
        candidates.push(cm.key)
    }
    for (const bp of db.botPresets ?? []) {
        candidates.push(bp.openAIKey)
        candidates.push(bp.proxyKey)
    }
    return candidates.filter((s): s is string => typeof s === 'string' && s.length > 0)
}
