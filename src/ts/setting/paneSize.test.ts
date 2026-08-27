import { describe, expect, it } from 'vitest'
import {
    DEFAULT_SETTINGS_SIDEBAR_WIDTH,
    MAX_SETTINGS_SIDEBAR_WIDTH,
    MIN_SETTINGS_SIDEBAR_WIDTH,
    SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY,
    clampSettingsSidebarWidth,
    readSettingsSidebarWidth,
    writeSettingsSidebarWidth,
} from './paneSize'

describe('settings pane size', () => {
    it('clamps the sidebar to its normal desktop bounds', () => {
        expect(clampSettingsSidebarWidth(80, 900)).toBe(MIN_SETTINGS_SIDEBAR_WIDTH)
        expect(clampSettingsSidebarWidth(900, 900)).toBe(MAX_SETTINGS_SIDEBAR_WIDTH)
    })

    it('reserves room for the settings content on a narrow desktop', () => {
        expect(clampSettingsSidebarWidth(400, 700)).toBe(340)
    })

    it('reads and writes the versioned local preference safely', () => {
        const values = new Map<string, string>()
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => { values.set(key, value) },
        }
        expect(readSettingsSidebarWidth(storage)).toBe(DEFAULT_SETTINGS_SIDEBAR_WIDTH)
        writeSettingsSidebarWidth(251.7, storage)
        expect(values.get(SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY)).toBe('252')
        expect(readSettingsSidebarWidth(storage)).toBe(252)
    })
})
