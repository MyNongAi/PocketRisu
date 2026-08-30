import { describe, expect, test } from 'vitest'
import { clampSplitWidth, getSecondaryRisuPaneUrl } from './chatSplitPane'

describe('clampSplitWidth', () => {
    test('keeps a useful primary chat width on desktop', () => {
        expect(clampSplitWidth(900, 1200)).toBe(840)
        expect(clampSplitWidth(100, 1200)).toBe(320)
    })

    test('adapts the minimum on narrow windows', () => {
        expect(clampSplitWidth(10, 700)).toBe(240)
        expect(clampSplitWidth(900, 700)).toBe(340)
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
