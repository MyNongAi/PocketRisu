import { describe, expect, it } from 'vitest'
import { AUTO_DEACTIVATE_DAY_MS, autoDeactivationCandidateIds, normalizeAutoDeactivateDays } from './characterAutoArchivePolicy'

const now = 200 * AUTO_DEACTIVATE_DAY_MS
const make = (chaId: string, lastDaysAgo?: number, extra: Record<string, unknown> = {}) => ({
    chaId,
    name: chaId,
    chats: [],
    lastInteraction: lastDaysAgo === undefined ? undefined : now - (lastDaysAgo * AUTO_DEACTIVATE_DAY_MS),
    ...extra,
}) as any

describe('automatic character deactivation policy', () => {
    it('is disabled by zero/invalid values and clamps excessive retention', () => {
        expect(normalizeAutoDeactivateDays(undefined)).toBe(0)
        expect(normalizeAutoDeactivateDays(-10)).toBe(0)
        expect(normalizeAutoDeactivateDays(99999)).toBe(3650)
    })

    it('selects only explicitly opened stale characters, oldest first', () => {
        expect(autoDeactivationCandidateIds([
            make('recent', 10),
            make('old', 100),
            make('oldest', 150),
            make('never-opened'),
        ], 90, now)).toEqual(['oldest', 'old'])
    })

    it('protects favorites, trash, current/generating exclusions and internal entries', () => {
        expect(autoDeactivationCandidateIds([
            make('favorite', 100, { favorite: true }),
            make('trash', 100, { trashTime: 1 }),
            make('selected', 100),
            make('§temp', 100),
            make('eligible', 100),
        ], 90, now, new Set(['selected']))).toEqual(['eligible'])
    })
})
