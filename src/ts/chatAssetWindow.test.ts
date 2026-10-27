import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    DEFAULT_EXTERNAL_ASSET_RECENT_OUTPUTS,
    getChatAssetRenderWindow,
    normalizeExternalAssetRecentOutputs,
    shouldResolveChatAssets,
    VIEWPORT_ASSET_COOL_MARGIN,
    VIEWPORT_ASSET_WARM_MARGIN,
    watchAssetViewport,
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
describe('shouldResolveChatAssets', () => {
    it('warms either the recent window or the visible viewport', () => {
        expect(shouldResolveChatAssets(true, false, 5)).toBe(true)
        expect(shouldResolveChatAssets(false, true, 5)).toBe(true)
        expect(shouldResolveChatAssets(false, false, 5)).toBe(false)
    })

    it('preserves legacy all-message rendering when the limit is zero', () => {
        expect(shouldResolveChatAssets(false, false, 0)).toBe(true)
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

class TestIntersectionObserver {
    static instances: TestIntersectionObserver[] = []
    observe = vi.fn()
    disconnect = vi.fn()

    constructor(private readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit) {
        TestIntersectionObserver.instances.push(this)
    }

    report(isIntersecting: boolean) {
        this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
}

describe('watchAssetViewport', () => {
    afterEach(() => {
        TestIntersectionObserver.instances = []
        vi.unstubAllGlobals()
        document.body.innerHTML = ''
    })

    const watch = () => {
        vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
        const scroller = document.createElement('div')
        scroller.className = 'default-chat-screen'
        const message = document.createElement('div')
        scroller.append(message)
        document.body.append(scroller)
        const changes: boolean[] = []
        const stop = watchAssetViewport(message, (visible) => changes.push(visible))
        const [warm, cool] = TestIntersectionObserver.instances
        return { scroller, message, changes, stop, warm, cool }
    }

    it('measures against the chat scroller, near to warm and far to cool', () => {
        const { scroller, message, warm, cool } = watch()
        expect(warm.options).toEqual({ root: scroller, rootMargin: VIEWPORT_ASSET_WARM_MARGIN })
        expect(cool.options).toEqual({ root: scroller, rootMargin: VIEWPORT_ASSET_COOL_MARGIN })
        expect(warm.observe).toHaveBeenCalledWith(message)
        expect(cool.observe).toHaveBeenCalledWith(message)
    })

    it('stays warm while a redraw moves the message just out of the view', () => {
        const { changes, warm, cool } = watch()
        warm.report(true)
        // Warmed, the message got shorter and its end left the view's top.
        warm.report(false)
        cool.report(true)
        expect(changes).toEqual([true])
        cool.report(false)
        expect(changes).toEqual([true, false])
    })

    it('stops both observers', () => {
        const { stop, warm, cool } = watch()
        stop()
        expect(warm.disconnect).toHaveBeenCalledOnce()
        expect(cool.disconnect).toHaveBeenCalledOnce()
    })
})
