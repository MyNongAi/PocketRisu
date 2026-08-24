import { describe, expect, it } from 'vitest'
import {
    SETTINGS_MENU_ORDER_STORAGE_KEY,
    mergeVisibleSettingsMenuOrder,
    moveVisibleSettingsMenuItem,
    normalizeSettingsMenuOrder,
    readSettingsMenuOrder,
    writeSettingsMenuOrder,
} from './menuOrder'

describe('settings menu order', () => {
    it('keeps a saved order, removes invalid duplicates, and appends new pages', () => {
        expect(normalizeSettingsMenuOrder(['persona', 'bot', 'persona', 'removed'], ['bot', 'persona', 'system']))
            .toEqual(['persona', 'bot', 'system'])
    })

    it('reorders visible pages without disturbing hidden lite-mode pages', () => {
        expect(mergeVisibleSettingsMenuOrder(
            ['bot', 'language', 'modules', 'migration'],
            ['migration', 'language'],
        )).toEqual(['bot', 'migration', 'modules', 'language'])
    })

    it('moves a keyboard-selected visible page without shifting hidden pages', () => {
        expect(moveVisibleSettingsMenuItem(
            ['bot', 'language', 'modules', 'migration'],
            ['language', 'migration'],
            'migration',
            -1,
        )).toEqual(['bot', 'migration', 'modules', 'language'])
    })

    it('keeps the order unchanged at keyboard movement boundaries', () => {
        expect(moveVisibleSettingsMenuItem(
            ['bot', 'language', 'migration'],
            ['language', 'migration'],
            'language',
            -1,
        )).toEqual(['bot', 'language', 'migration'])
    })

    it('falls back safely when persisted JSON is invalid', () => {
        const storage = {
            getItem: () => '{broken',
            setItem: () => undefined,
        }
        expect(readSettingsMenuOrder(['bot', 'persona'], storage)).toEqual(['bot', 'persona'])
    })

    it('writes the stable versioned key', () => {
        const values = new Map<string, string>()
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => { values.set(key, value) },
        }
        writeSettingsMenuOrder(['persona', 'bot', 'persona'], storage)
        expect(values.get(SETTINGS_MENU_ORDER_STORAGE_KEY)).toBe('["persona","bot"]')
    })
})
