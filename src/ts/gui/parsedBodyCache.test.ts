import { afterEach, describe, expect, it, vi } from 'vitest'
import { getParsedBody, parsedBodyKey, pendingBodyNeedsRestart, plainBodyHtml, putParsedBody, withFallbackTimeout } from './parsedBodyCache'

afterEach(() => vi.useRealTimers())

describe('resuming parsed chat bodies', () => {
    const identity = {
        chatId: 'chat-a', messageId: 'message-a', index: 2, source: 'hello',
        mode: 'notrim', translated: false, hideAllImages: false, resolveAssets: true,
    }

    it('keys by message, source, and rendering inputs', () => {
        const key = parsedBodyKey(identity)
        expect(parsedBodyKey({ ...identity, index: 3 })).toBe(key)
        for (const change of [
            { chatId: 'chat-b' }, { messageId: 'message-b' }, { source: 'hello!' },
            { mode: 'log' }, { translated: true }, { hideAllImages: true }, { resolveAssets: false },
        ]) expect(parsedBodyKey({ ...identity, ...change })).not.toBe(key)
        expect(parsedBodyKey({ ...identity, messageId: undefined, index: 3 }))
            .not.toBe(parsedBodyKey({ ...identity, messageId: undefined }))
    })

    it('hits, misses, and evicts the least recently used entry', () => {
        const prefix = 'body-cache-test:'
        for (let i = 0; i < 300; i++) putParsedBody(`${prefix}${i}`, `body ${i}`)
        expect(getParsedBody(`${prefix}0`)).toBe('body 0')
        putParsedBody(`${prefix}300`, 'new')
        expect(getParsedBody(`${prefix}1`)).toBeUndefined()
        expect(getParsedBody(`${prefix}0`)).toBe('body 0')
        expect(getParsedBody(`${prefix}300`)).toBe('new')
    })

    it('escapes text and preserves line breaks', () => {
        expect(plainBodyHtml('<script>"x" & y\r\nnext\n\'last\''))
            .toBe('&lt;script&gt;&quot;x&quot; &amp; y<br>next<br>&#39;last&#39;')
    })

    it('restarts only a parse pending longer than three seconds', () => {
        expect(pendingBodyNeedsRestart(null, 4000)).toBe(false)
        expect(pendingBodyNeedsRestart(1000, 4000)).toBe(false)
        expect(pendingBodyNeedsRestart(1000, 4001)).toBe(true)
    })

    it('returns quick work or a timeout fallback and ignores late settlement', async () => {
        vi.useFakeTimers()
        expect(await withFallbackTimeout(Promise.resolve('ready'), 8000, () => 'fallback')).toBe('ready')
        let resolveWork!: (value: string) => void
        const work = new Promise<string>(resolve => { resolveWork = resolve })
        const result = withFallbackTimeout(work, 8000, () => 'fallback')
        await vi.advanceTimersByTimeAsync(8000)
        expect(await result).toBe('fallback')
        resolveWork('late')
        await Promise.resolve()
        expect(await result).toBe('fallback')
        let rejectWork!: (error: Error) => void
        const failing = new Promise<string>((_resolve, reject) => { rejectWork = reject })
        const failedResult = withFallbackTimeout(failing, 8000, () => 'fallback')
        await vi.advanceTimersByTimeAsync(8000)
        rejectWork(new Error('late rejection'))
        expect(await failedResult).toBe('fallback')
    })
})
