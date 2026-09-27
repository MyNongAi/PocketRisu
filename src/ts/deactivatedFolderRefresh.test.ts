import { afterEach, describe, expect, it, vi } from 'vitest'

const checkCharOrder = vi.fn()
vi.mock('./globalApi.svelte', () => ({ checkCharOrder: () => checkCharOrder() }))
// The settings list pulls these in; only the grouping item is under test.
vi.mock('./characterAutoArchive', () => ({ scheduleAutoDeactivation: vi.fn() }))
vi.mock('./storage/database.svelte', () => ({ getCurrentChat: vi.fn(), getDatabase: vi.fn(), loadTogglesFromChat: vi.fn() }))
vi.mock('./platform', () => ({ isNodeServer: true }))

const { scheduleDeactivatedFolderRefresh } = await import('./deactivatedFolderRefresh')
const { accessibilityCharacterItems, accessibilitySettingsItems } = await import('./setting/accessibilitySettingsData')

const HOUR = 60 * 60 * 1000

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    checkCharOrder.mockReset()
})

describe('hourly re-bucketing', () => {
    it('arms one interval that runs checkCharOrder every hour and survives a failing run', () => {
        vi.useFakeTimers()
        scheduleDeactivatedFolderRefresh()
        scheduleDeactivatedFolderRefresh()
        expect(vi.getTimerCount()).toBe(1)

        vi.advanceTimersByTime(HOUR - 1)
        expect(checkCharOrder).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(checkCharOrder).toHaveBeenCalledTimes(1)

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        checkCharOrder.mockImplementationOnce(() => { throw new Error('boom') })
        expect(() => vi.advanceTimersByTime(HOUR)).not.toThrow()
        expect(warn).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(HOUR)
        expect(checkCharOrder).toHaveBeenCalledTimes(3)
    })
})

describe('the grouping setting', () => {
    const item = accessibilitySettingsItems.find((candidate) => candidate.id === 'acc.nodeOnlyGroupDeactivatedCharacters')!

    it('sits right after "hide deactivated characters" in the character list settings', () => {
        const idsInOrder = accessibilityCharacterItems.map((candidate) => candidate.id)
        const hide = idsInOrder.indexOf('acc.nodeOnlyHideArchivedCharacters')
        expect(hide).toBeGreaterThanOrEqual(0)
        expect(idsInOrder[hide + 1]).toBe('acc.nodeOnlyGroupDeactivatedCharacters')
        const allIds = accessibilitySettingsItems.map((candidate) => candidate.id)
        expect(allIds[allIds.indexOf('acc.nodeOnlyHideArchivedCharacters') + 1]).toBe('acc.nodeOnlyGroupDeactivatedCharacters')
        expect(item).toMatchObject({ type: 'check', labelKey: 'groupDeactivatedCharacters', helpKey: 'groupDeactivatedCharacters' })
    })

    it('reads undefined as on and writes a boolean', () => {
        const db: any = {}
        expect(item.getValue!(db)).toBe(true)
        item.setValue!(db, false)
        expect(db.nodeOnlyGroupDeactivatedCharacters).toBe(false)
        expect(item.getValue!(db)).toBe(false)
        item.setValue!(db, 1)
        expect(db.nodeOnlyGroupDeactivatedCharacters).toBe(true)
    })

    it('gathers or releases the folders right away', () => {
        item.onChange!(false, {} as any)
        expect(checkCharOrder).toHaveBeenCalledTimes(1)
    })
})
