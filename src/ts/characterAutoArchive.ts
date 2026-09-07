import { get } from 'svelte/store'
import { archiveCharacter } from './characterArchive'
import { autoDeactivationCandidateIds, normalizeAutoDeactivateDays } from './characterAutoArchivePolicy'
import { getDatabase } from './storage/database.svelte'
import { generationStates } from './process/generationState'
import { selectedCharID } from './stores.svelte'
import { isNodeServer } from './platform'

const SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000
const CONTINUATION_DELAY_MS = 60 * 1000
const DEFAULT_BATCH_SIZE = 20

let scheduledTimer: ReturnType<typeof setTimeout> | null = null
let runningSweep: Promise<AutoDeactivationResult> | null = null

export interface AutoDeactivationResult {
    eligible: number
    deactivated: number
    failed: number
    skipped: boolean
}

function activeCharacterIds(): Set<string> {
    const db = getDatabase()
    const ids = new Set<string>()
    const selectedIndex = get(selectedCharID)
    const selected = db.characters[selectedIndex]?.chaId
    if (selected) ids.add(selected)
    for (const state of get(generationStates).values()) {
        if (state.context?.characterId) ids.add(state.context.characterId)
    }
    return ids
}

function idleTurn(): Promise<void> {
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        return new Promise((resolve) => window.requestIdleCallback(() => resolve(), { timeout: 1500 }))
    }
    return new Promise((resolve) => setTimeout(resolve, 0))
}

async function performSweep(force: boolean, limit: number): Promise<AutoDeactivationResult> {
    const db = getDatabase()
    const days = normalizeAutoDeactivateDays(db.nodeOnlyAutoDeactivateAfterDays)
    if (!isNodeServer || days === 0) return { eligible: 0, deactivated: 0, failed: 0, skipped: true }

    const now = Date.now()
    if (!force && now - Number(db.nodeOnlyAutoDeactivateLastRun || 0) < SWEEP_INTERVAL_MS) {
        return { eligible: 0, deactivated: 0, failed: 0, skipped: true }
    }

    const candidates = autoDeactivationCandidateIds(db.characters, days, now, activeCharacterIds())
    let deactivated = 0
    let failed = 0

    for (const chaId of candidates.slice(0, Math.max(1, limit))) {
        if (normalizeAutoDeactivateDays(db.nodeOnlyAutoDeactivateAfterDays) === 0) break
        await idleTurn()
        const index = db.characters.findIndex((character) => character?.chaId === chaId)
        if (index < 0 || activeCharacterIds().has(chaId)) continue
        try {
            if (await archiveCharacter(index, {
                skipConfirm: true,
                silent: true,
                automatic: true,
            })) deactivated++
        } catch (error) {
            failed++
            console.warn('[AutoDeactivate] skipped character:', chaId, error)
        }
    }

    db.nodeOnlyAutoDeactivateLastRun = Date.now()
    const remaining = autoDeactivationCandidateIds(db.characters, days, Date.now(), activeCharacterIds()).length
    if (remaining > 0 && db.nodeOnlyAutoDeactivateAfterDays) {
        scheduleAutoDeactivation({ delayMs: CONTINUATION_DELAY_MS, force: true })
    }
    console.info(`[AutoDeactivate] eligible=${candidates.length} deactivated=${deactivated} failed=${failed} remaining=${remaining}`)
    return { eligible: candidates.length, deactivated, failed, skipped: false }
}

export function runAutoDeactivationSweep(options: { force?: boolean; limit?: number } = {}): Promise<AutoDeactivationResult> {
    if (runningSweep) return runningSweep
    runningSweep = performSweep(options.force === true, options.limit ?? DEFAULT_BATCH_SIZE)
        .finally(() => { runningSweep = null })
    return runningSweep
}

export function scheduleAutoDeactivation(options: { delayMs?: number; force?: boolean } = {}): void {
    if (scheduledTimer) clearTimeout(scheduledTimer)
    scheduledTimer = null
    if (!isNodeServer || normalizeAutoDeactivateDays(getDatabase().nodeOnlyAutoDeactivateAfterDays) === 0) return
    scheduledTimer = setTimeout(() => {
        scheduledTimer = null
        void runAutoDeactivationSweep({ force: options.force })
    }, Math.max(0, options.delayMs ?? 15_000))
}
