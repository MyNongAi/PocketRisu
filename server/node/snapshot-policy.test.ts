import { describe, expect, it } from 'vitest'

const {
    SNAPSHOT_HOUR_MS,
    SNAPSHOT_INTERVAL_DEFAULT_MS,
    SNAPSHOT_INTERVAL_OPTIONS_MS,
    isAllowedSnapshotInterval,
    latestSnapshotTimestamp,
    parseConfiguredSnapshotInterval,
    parseSnapshotIntervalOverride,
    parseSnapshotTimestamp,
} = require('./snapshot-policy.cjs') as {
    SNAPSHOT_HOUR_MS: number
    SNAPSHOT_INTERVAL_DEFAULT_MS: number
    SNAPSHOT_INTERVAL_OPTIONS_MS: readonly number[]
    isAllowedSnapshotInterval: (value: unknown) => boolean
    latestSnapshotTimestamp: (keys: string[], prefix?: string) => number | null
    parseConfiguredSnapshotInterval: (raw: unknown) => number
    parseSnapshotIntervalOverride: (raw: unknown) => number | null
    parseSnapshotTimestamp: (key: unknown, prefix?: string) => number | null
}

describe('snapshot interval policy', () => {
    it('defaults missing and invalid legacy values to 12 hours', () => {
        expect(SNAPSHOT_INTERVAL_DEFAULT_MS).toBe(12 * SNAPSHOT_HOUR_MS)
        expect(parseConfiguredSnapshotInterval(null)).toBe(12 * SNAPSHOT_HOUR_MS)
        expect(parseConfiguredSnapshotInterval(Buffer.from('garbage'))).toBe(12 * SNAPSHOT_HOUR_MS)
        expect(parseConfiguredSnapshotInterval('5')).toBe(12 * SNAPSHOT_HOUR_MS)
    })

    it('accepts only off, 1h, 6h, 12h, and 24h for persisted settings', () => {
        expect(SNAPSHOT_INTERVAL_OPTIONS_MS).toEqual([
            0,
            SNAPSHOT_HOUR_MS,
            6 * SNAPSHOT_HOUR_MS,
            12 * SNAPSHOT_HOUR_MS,
            24 * SNAPSHOT_HOUR_MS,
        ])
        for (const value of SNAPSHOT_INTERVAL_OPTIONS_MS) {
            expect(isAllowedSnapshotInterval(value)).toBe(true)
            expect(parseConfiguredSnapshotInterval(Buffer.from(String(value)))).toBe(value)
        }
        expect(isAllowedSnapshotInterval(2 * SNAPSHOT_HOUR_MS)).toBe(false)
    })

    it('keeps the legacy environment override semantics used by compat tests', () => {
        expect(parseSnapshotIntervalOverride(undefined)).toBeNull()
        expect(parseSnapshotIntervalOverride('')).toBeNull()
        expect(parseSnapshotIntervalOverride('-1')).toBeNull()
        expect(parseSnapshotIntervalOverride('invalid')).toBeNull()
        expect(parseSnapshotIntervalOverride('0')).toBe(0)
        expect(parseSnapshotIntervalOverride('25')).toBe(25)
    })
})

describe('persisted snapshot timestamps', () => {
    it('decodes the on-disk 100 ms timestamp key format', () => {
        expect(parseSnapshotTimestamp('database/dbbackup-12345.bin')).toBe(1_234_500)
        expect(parseSnapshotTimestamp('database/dbbackup-nope.bin')).toBeNull()
        expect(parseSnapshotTimestamp('database/dbbackup-12345.bin.tmp')).toBeNull()
        expect(parseSnapshotTimestamp('other/dbbackup-12345.bin')).toBeNull()
    })

    it('finds the newest valid snapshot so cooldown survives a restart', () => {
        expect(latestSnapshotTimestamp([
            'database/dbbackup-100.bin',
            'database/dbbackup-invalid.bin',
            'database/dbbackup-350.bin',
            'database/dbbackup-200.bin',
        ])).toBe(35_000)
        expect(latestSnapshotTimestamp([])).toBeNull()
    })
})
