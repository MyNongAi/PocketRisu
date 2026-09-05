import { describe, expect, test } from 'vitest'
import { clampSplitWidth, getSecondaryRisuPaneUrl, getSplitWidthBounds } from './chatSplitPane'

describe('clampSplitWidth', () => {
    test('allows either desktop pane to become narrow without collapsing it', () => {
        expect(getSplitWidthBounds(1200)).toEqual({ min: 216, max: 984 })
        expect(clampSplitWidth(1100, 1200)).toBe(984)
        expect(clampSplitWidth(100, 1200)).toBe(216)
    })

    test('keeps a broad drag range on narrow split windows', () => {
        expect(getSplitWidthBounds(700)).toEqual({ min: 160, max: 540 })
        expect(clampSplitWidth(10, 700)).toBe(160)
        expect(clampSplitWidth(900, 700)).toBe(540)
    })

    test('caps the minimum on wide screens and remains safe below 320px', () => {
        expect(getSplitWidthBounds(1920)).toEqual({ min: 280, max: 1640 })
        expect(getSplitWidthBounds(300)).toEqual({ min: 150, max: 150 })
    })
})

describe('getSecondaryRisuPaneUrl', () => {
    test('opens the whole PocketRisu route as the secondary workspace', () => {
        const url = new URL(getSecondaryRisuPaneUrl(), window.location.href)
        expect(url.pathname).toBe(window.location.pathname)
        expect(url.searchParams.get('pocketrisuPane')).toBe('secondary')
        expect(url.hash).toBe('')
    })
})
