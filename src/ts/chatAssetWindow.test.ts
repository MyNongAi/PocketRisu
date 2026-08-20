import { describe, expect, it } from 'vitest'
import {
    DEFAULT_EXTERNAL_ASSET_RECENT_OUTPUTS,
    getChatAssetRenderWindow,
    normalizeExternalAssetRecentOutputs,
} from './chatAssetWindow'

describe('normalizeExternalAssetRecentOutputs', () => {
    it('keeps zero and non-negative finite integers', () => {
        expect(normalizeExternalAssetRecentOutputs(0)).toBe(0)
        expect(normalizeExternalAssetRecentOutputs(7.9)).toBe(7)
    })

    it('uses the default for invalid values', () => {
        expect(normalizeExternalAssetRecentOutputs(undefined)).toBe(DEFAULT_EXTERNAL_ASSET_RECENT_OUTPUTS)
        expect(normalizeExternalAssetRecentOutputs(-1)).toBe(DEFAULT_EXTERNAL_ASSET_RECENT_OUTPUTS)
        expect(normalizeExternalAssetRecentOutputs(Number.NaN)).toBe(DEFAULT_EXTERNAL_ASSET_RECENT_OUTPUTS)
    })
})
describe('getChatAssetRenderWindow', () => {
    it('selects only the newest actual character outputs', () => {
        const messages = [
            { role: 'char' },
            { role: 'user' },
            { role: 'char', isComment: true },
            { role: 'char' },
            { role: 'char', disabled: true },
            { role: 'char' },
        ]

        const window = getChatAssetRenderWindow(messages, 2)
        expect([...window.messageIndices].sort((a, b) => a - b)).toEqual([3, 5])
        expect(window.firstMessage).toBe(false)
    })

    it('lets the first greeting occupy the remaining oldest slot', () => {
        const window = getChatAssetRenderWindow([
            { role: 'user' },
            { role: 'char' },
            { role: 'char' },
        ], 3)

        expect([...window.messageIndices].sort((a, b) => a - b)).toEqual([1, 2])
        expect(window.firstMessage).toBe(true)
    })

    it('evicts the first greeting after enough character outputs exist', () => {
        const window = getChatAssetRenderWindow([
            { role: 'char' },
            { role: 'char' },
            { role: 'char' },
        ], 2)

        expect([...window.messageIndices].sort((a, b) => a - b)).toEqual([1, 2])
        expect(window.firstMessage).toBe(false)
    })

    it('uses legacy all-message behaviour when the limit is zero', () => {
        const window = getChatAssetRenderWindow([
            { role: 'user' },
            { role: 'char', disabled: true },
            { role: 'char', isComment: true },
        ], 0)

        expect([...window.messageIndices]).toEqual([0, 1, 2])
        expect(window.firstMessage).toBe(true)
    })

    it('does not enable a disabled first greeting', () => {
        expect(getChatAssetRenderWindow([], 5, false).firstMessage).toBe(false)
    })
})
