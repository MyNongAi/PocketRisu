/**
 * v4 ModelPreset 백엔드 smoke harness.
 *
 * 입력 형식 두 가지를 자동 감지:
 *   - SMOKE_DB_PATH가 `.db`로 끝남 → SQLite (`save/risuai.db`). readonly로 열고
 *     `kv` 테이블에서 `database/database.bin` row의 value를 꺼낸 뒤 디코딩.
 *   - 그 외 → 단일 RisuSave Legacy `.bin` 파일로 간주, 직접 디코딩.
 *     (UI backup으로 받은 archive 형식은 미지원 — 그런 archive 안에서는
 *     database entry 외에 character/asset 등이 섞여 있어 추출 단계가 필요함.)
 *
 * 다음 네 영역을 dry-run으로 검증:
 *   1. analyze report   — migration이 어떤 ModelPreset 후보를 만드는지
 *   2. dry-run apply    — apiKeyPool / binding integrity / orphan
 *   3. adapter wire     — 각 migrated preset의 buildPreparedRequest 출력
 *   4. .bin round-trip  — apply 결과를 다시 encode → 같은 라이브러리로 decode
 *
 * 출력은 stdout에만 쓴다. 입력 파일은 절대 건드리지 않는다.
 * 비밀 key는 redact해서 출력한다.
 *
 * 실행:
 *   SMOKE_DB_PATH=/path/to/save/risuai.db \
 *     pnpm test:v4-smoke
 *   # 또는
 *   SMOKE_DB_PATH=/path/to/raw-export.bin \
 *     pnpm test:v4-smoke
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

interface BetterSqliteDatabase {
    prepare: (sql: string) => { get: (...params: unknown[]) => Record<string, unknown> | undefined }
    close: () => void
    pragma: (sql: string) => unknown
}
type BetterSqliteCtor = new (
    path: string,
    options?: { readonly?: boolean; fileMustExist?: boolean },
) => BetterSqliteDatabase

/**
 * Read the legacy DB blob out of the live SQLite store at the given path.
 * Opens readonly + WAL-aware so the running server (if any) is unaffected.
 */
function readDbBlobFromSqlite(dbPath: string): Uint8Array {
    const Database = require('better-sqlite3') as BetterSqliteCtor
    const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
        sqlite.pragma('journal_mode = WAL')
        const row = sqlite.prepare('SELECT value FROM kv WHERE key = ?').get('database/database.bin')
        if (!row || !(row.value instanceof Uint8Array || Buffer.isBuffer(row.value))) {
            throw new Error(
                `SQLite at ${dbPath} has no kv row for key="database/database.bin" — `
                + 'unable to extract legacy DB blob.',
            )
        }
        return new Uint8Array(row.value as Buffer)
    } finally {
        sqlite.close()
    }
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
    const snap = preset.profileSnapshot as (ModelPreset['profileSnapshot'] | undefined)
    if (!snap) {
        return {
            id: preset.id,
            name: preset.name,
            warning: 'INCOMPLETE: profileSnapshot is missing (pre-v4 or partial migration?)',
            keysPresent: Object.keys(preset as unknown as Record<string, unknown>),
            migrationSource: preset.migrationSource ?? null,
            hasApiKeyRef: Boolean(preset.apiKeyRef),
        }
    }
    return {
        id: preset.id,
        name: preset.name,
        profileId: snap.profileId,
        providerBaseId: snap.providerBaseId,
        providerBaseVersion: snap.providerBaseVersion,
        adapterKind: snap.adapterKind,
        authKind: snap.auth?.kind,
        endpoint: snap.endpoint,
        modelId: snap.modelId,
        hasApiKeyRef: Boolean(preset.apiKeyRef),
        migrationSource: preset.migrationSource,
        userValueKeys: Object.keys(preset.userValues ?? {}),
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

        const isSqlite = dbPath.toLowerCase().endsWith('.db')
        const buffer = isSqlite
            ? readDbBlobFromSqlite(dbPath)
            : new Uint8Array(fs.readFileSync(dbPath))
        if (isSqlite) {
            console.log(`source: SQLite (kv['database/database.bin'])`)
            console.log(`extracted blob size: ${buffer.length} bytes`)
        } else {
            console.log(`source: raw RisuSave .bin`)
        }
        const decoded = await utilsCjs.decodeRisuSave(buffer)
        const db = decoded as ModelPresetMigrationApplyTarget
        console.log(`decoded top-level keys: ${Object.keys(decoded).length}`)
        const existingPresets = db.modelPresets ?? []
        const existingApiKeyPool = db.apiKeyPool ?? {}
        console.log(`already-migrated modelPresets: ${existingPresets.length}`)
        console.log(`existing apiKeyPool entries: ${Object.keys(existingApiKeyPool).length}`)
        console.log(`migrationVersion: ${db.modelPresetMigrationVersion ?? '<none>'}`)

        // Diagnostic: dump what's already in the v4 fields so we can tell
        // whether the user db was previously touched by partial migration code.
        if (existingPresets.length > 0) {
            console.log('--- existing preset summaries (pre-existing in db) ---')
            for (const p of existingPresets) {
                console.log(JSON.stringify(summarizePreset(p)))
            }
        }
        if (Object.keys(existingApiKeyPool).length > 0) {
            console.log('--- existing apiKeyPool entries (id / provider / hasKey) ---')
            for (const [id, entry] of Object.entries(existingApiKeyPool)) {
                const e = entry as { id?: string; provider?: string; key?: string; name?: string }
                console.log(`  • ${id}: provider=${e.provider ?? '?'}, hasKey=${Boolean(e.key)}, name=${e.name ?? '?'}`)
            }
        }

        // Diagnostic: which legacy aiModel values appear in botPresets — so we
        // can see why so many manualRequired entries land on "Unsupported
        // legacy model: custom". 'custom' is NOT a standard upstream model id,
        // so it likely indicates a reverse-proxy-bound botPreset that the
        // analyzer's profileForLegacyModel does not recognize.
        const legacyValueCounts = new Map<string, number>()
        const inc = (v: string | undefined) => {
            if (!v) return
            legacyValueCounts.set(v, (legacyValueCounts.get(v) ?? 0) + 1)
        }
        inc(db.aiModel)
        inc(db.subModel)
        for (const bp of db.botPresets ?? []) {
            inc(bp.aiModel)
            inc(bp.subModel)
        }
        const interesting = [...legacyValueCounts.entries()]
            .filter(([v, c]) => c >= 2 || v === 'custom' || v === 'reverse_proxy')
            .sort((a, b) => b[1] - a[1])
        if (interesting.length > 0) {
            console.log('--- legacy aiModel/subModel value frequency (filtered) ---')
            for (const [v, c] of interesting) {
                console.log(`  • "${v}" × ${c}`)
            }
        }

        // Diagnostic: for botPresets where aiModel/subModel is 'custom' (the
        // legacy "Plugin Legacy" model), show neighboring fields so we can
        // tell whether the user was using plugin route, reverse proxy, or a
        // mix. analyzer currently lacks a 'custom' branch.
        type LegacyBot = {
            id?: string
            name?: string
            aiModel?: string
            subModel?: string
            currentPluginProvider?: string
            forceReplaceUrl?: string
            proxyRequestModel?: string
            customProxyRequestModel?: string
            customAPIFormat?: number
            proxyKey?: string
            reverseProxyOobaArgs?: unknown
        }
        const customBots = (db.botPresets ?? []).filter((bp) => {
            const x = bp as LegacyBot
            return x.aiModel === 'custom' || x.subModel === 'custom'
        }) as LegacyBot[]
        if (customBots.length > 0) {
            console.log(`--- botPresets with aiModel/subModel === 'custom' (${customBots.length} total) ---`)
            for (const bp of customBots) {
                console.log(`  • ${bp.id ?? '<no-id>'} "${bp.name ?? ''}"`)
                console.log(
                    `      aiModel="${bp.aiModel}", subModel="${bp.subModel}", `
                    + `pluginProvider="${bp.currentPluginProvider ?? ''}", `
                    + `forceReplaceUrl="${bp.forceReplaceUrl ?? ''}", `
                    + `customAPIFormat=${bp.customAPIFormat ?? '<none>'}`
                )
            }
            console.log(`db.currentPluginProvider = "${(db as { currentPluginProvider?: string }).currentPluginProvider ?? ''}"`)
        }

        // Diagnostic: forceReplaceUrl presence per bot-preset that has
        // reverse_proxy plumbing (proxyRequestModel/customProxyRequestModel/
        // proxyKey/forceReplaceUrl any). This shows whether the empty endpoint
        // URL in migrated reverse-proxy presets is caused by user data or by
        // analyzer extraction.
        const proxyBots = (db.botPresets ?? []).filter((bp) => {
            const x = bp as LegacyBot
            return Boolean(
                x.aiModel === 'reverse_proxy' || x.subModel === 'reverse_proxy'
                || x.forceReplaceUrl || x.proxyRequestModel
                || x.customProxyRequestModel || x.proxyKey
            )
        }) as LegacyBot[]
        if (proxyBots.length > 0) {
            console.log(`--- botPresets touching reverse_proxy fields (${proxyBots.length} total) ---`)
            for (const bp of proxyBots) {
                console.log(
                    `  • ${bp.id ?? '<no-id>'}: aiModel="${bp.aiModel ?? ''}", `
                    + `forceReplaceUrl="${(bp.forceReplaceUrl ?? '').slice(0, 60)}${(bp.forceReplaceUrl ?? '').length > 60 ? '…' : ''}", `
                    + `proxyRequestModel="${bp.proxyRequestModel ?? ''}", `
                    + `customProxyRequestModel="${bp.customProxyRequestModel ?? ''}", `
                    + `customAPIFormat=${bp.customAPIFormat ?? '<none>'}, `
                    + `hasProxyKey=${Boolean(bp.proxyKey)}`
                )
            }
        }
        // Diagnostic: top-level db.forceReplaceUrl + db.proxyKey to see whether
        // the reverse-proxy plumbing lives at the global level instead of per-bot.
        const topDb = db as { forceReplaceUrl?: string; proxyKey?: string; customProxyRequestModel?: string }
        console.log(
            `--- db top-level reverse_proxy fields ---\n`
            + `  • db.forceReplaceUrl="${topDb.forceReplaceUrl ?? ''}"\n`
            + `  • db.customProxyRequestModel="${topDb.customProxyRequestModel ?? ''}"\n`
            + `  • db.proxyKey present=${Boolean(topDb.proxyKey)}`
        )

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
            // Skip presets that are not v4-shaped (e.g., pre-existing
            // template-based presets from another model preset system in the
            // same DB row). Mark them in the report so the user can
            // investigate where they came from.
            const snap = preset.profileSnapshot
            if (!snap || !snap.auth) {
                wireSkipped++
                console.log(`  • [skipped] ${preset.id}: missing profileSnapshot (not a v4 preset)`)
                continue
            }
            // SA auth needs async credential resolve via resolveAdapterCredential;
            // skip here. Coverage for that path lives in adapter unit tests.
            if (snap.auth.kind === 'google-service-account') {
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
                    `  • [${snap.profileId}] ${prepared.method} ${prepared.url}`
                    + ` (auth=${snap.auth.kind})`
                )
            } catch (err) {
                wireFailures.push({
                    presetId: preset.id,
                    error: err instanceof Error ? err.message : String(err),
                })
            }
        }
        console.log(`wire smoke: ${wireOK} ok / ${wireSkipped} skipped / ${wireFailures.length} failed`)
        if (wireFailures.length > 0) {
            console.log('--- wire failures ---')
            for (const f of wireFailures) console.log(`  • ${f.presetId}: ${f.error}`)
        }
        // Smoke should report failures but not abort with assertion — we want
        // the full output for analysis even when issues are present.

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
